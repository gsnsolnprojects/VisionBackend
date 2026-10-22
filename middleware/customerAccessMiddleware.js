const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const Model = require('../models/Model');
const TrainingJob = require('../models/TrainingJob');
const { countTrainingRunsThisMonth } = require('../utils/usage');

/**
 * Customer access rules (everyone outside GSN)
 *
 * GSN (the superadmin and the GSN team) keeps every ability. Other companies work with
 * GSN's sample datasets, which they add to their projects as read-only links, and - when
 * their plan includes trainOnOwnDatasets - with datasets they upload themselves:
 *  - they can create projects, train models and run inference (also on uploaded images)
 *  - with trainOnOwnDatasets they can upload a dataset and add/delete its files, label it
 *    and edit its classes (plan limits on count, images and file size: utils/datasetAllowance)
 *  - they can't augment or duplicate datasets
 *  - they can train only nano or small models, at most CUSTOMER_MODEL_LIMIT per company
 *    (deleting a model frees its slot; linked sample models don't count), and no more than
 *    the plan's trainingRunsPerMonth
 *
 * Independently of who is asking, a linked sample dataset is never changed in place:
 * its folder is GSN's shared copy.
 */

const GSN_COMPANY = 'gsn';
const CUSTOMER_MODEL_LIMIT = 2;
const CUSTOMER_MODEL_SIZES = ['n', 's'];

const isGsnUser = (user) => String(user?.company || '').trim().toLowerCase() === GSN_COMPANY;

const DATASET_ROUTE = /^\/api\/dataset\/([^/]+)(\/.*)?$/;

/** Dataset requests only GSN may make (method + path after /api/dataset) */
const GSN_ONLY = [
  ['POST', /^\/[^/]+\/augment$/],
  ['POST', /^\/[^/]+\/duplicate$/],
];

/** Work on a company's own dataset, open to customers whose plan has trainOnOwnDatasets */
const OWN_DATASET_WORK = [
  ['POST', /^\/upload$/],
  ['POST', /^\/[^/]+\/create-categories-from-classes$/],
  ['POST', /^\/[^/]+\/files$/],
  ['DELETE', /^\/[^/]+\/files\/[^/]+$/],
  ['PATCH', /^\/[^/]+$/],
  ['POST', /^\/[^/]+\/annotations(\/batch)?$/],
  ['PUT', /^\/[^/]+\/annotations\/[^/]+$/],
  ['DELETE', /^\/[^/]+\/annotations\/[^/]+$/],
  ['POST', /^\/[^/]+\/import-labels-to-annotations$/],
  ['POST', /^\/[^/]+\/click-to-mask$/],
  ['POST', /^\/[^/]+\/convert-annotations-to-labels$/],
  ['POST', /^\/[^/]+\/categories$/],
  ['PUT', /^\/[^/]+\/categories\/[^/]+$/],
  ['DELETE', /^\/[^/]+\/categories\/[^/]+$/],
];

/** Requests on one dataset that leave the dataset unchanged, so they're fine on a linked one */
const LINK_SAFE = [
  ['DELETE', /^\/[^/]+$/], // removes the link itself
  ['POST', /^\/[^/]+\/augment\/cancel$/],
];

const GSN_ONLY_MESSAGE = 'Augmenting and duplicating datasets is not available in your workspace.';
const SAMPLE_ONLY_MESSAGE =
  'Your workspace works with GSN sample datasets. Add one with "Add sample dataset"; uploading, labelling and editing datasets is not available.';
const LINKED_READ_ONLY_MESSAGE =
  'This is a shared GSN sample dataset and can\'t be changed. You can train on it and use it for testing.';

const matches = (rules, method, subPath) => rules.some(([m, re]) => m === method && re.test(subPath));

const DOWNLOAD_ROUTE = /^\/api\/dataset\/([^/]+)\/download$/;

async function customerAccess(req, res, next) {
  try {
    if (req.method === 'OPTIONS' || !req.user) return next();
    const urlPath = req.originalUrl.split('?')[0];

    // GSN's sample data can be used in a customer's project, not downloaded
    if (req.method === 'GET') {
      const download = urlPath.match(DOWNLOAD_ROUTE);
      if (download && !isGsnUser(req.user) && mongoose.Types.ObjectId.isValid(download[1])) {
        const linked = await Dataset.exists({ _id: download[1], linkedFrom: { $ne: null } });
        if (linked) {
          const message = "Shared GSN sample datasets can't be downloaded.";
          return res.status(403).json({ error: message, message, code: 'linked_no_download' });
        }
      }
      return next();
    }

    const route = urlPath.match(DATASET_ROUTE);
    if (!route) return next();
    const subPath = urlPath.slice('/api/dataset'.length);

    if (!isGsnUser(req.user)) {
      if (matches(GSN_ONLY, req.method, subPath)) {
        return res.status(403).json({ error: GSN_ONLY_MESSAGE, message: GSN_ONLY_MESSAGE, code: 'gsn_only' });
      }
      const ownDatasets = req.user.access?.features?.trainOnOwnDatasets === true;
      if (!ownDatasets && matches(OWN_DATASET_WORK, req.method, subPath)) {
        return res.status(403).json({ error: SAMPLE_ONLY_MESSAGE, message: SAMPLE_ONLY_MESSAGE, code: 'samples_only' });
      }
    }

    // Linked sample datasets are read-only for everyone
    const datasetId = route[1];
    if (mongoose.Types.ObjectId.isValid(datasetId) && !matches(LINK_SAFE, req.method, subPath)) {
      const linked = await Dataset.exists({ _id: datasetId, linkedFrom: { $ne: null } });
      if (linked) {
        return res.status(403).json({ error: LINKED_READ_ONLY_MESSAGE, message: LINKED_READ_ONLY_MESSAGE, code: 'linked_read_only' });
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Models a customer company has trained itself (linked sample models don't count) */
const countOwnModels = (company) => Model.countDocuments({ company, linkedFrom: null });

/** Training jobs still on their way to becoming a model */
const countPendingTrainings = (company) =>
  TrainingJob.countDocuments({ company, status: { $in: ['queued', 'pending', 'running'] } });

/** The size letter of a YOLO size/key: "s", "v8s", "base-v11s-seg" -> "s" */
function sizeLetter(modelSize, modelKey) {
  const key = String(modelKey || '').match(/^base-v(?:5|8|11|26)([nsmlx])(?:-seg)?$/i);
  if (key) return key[1].toLowerCase();
  const size = String(modelSize || 'n').match(/([nsmlx])$/i);
  return size ? size[1].toLowerCase() : null;
}

/**
 * Training rules for customers. Returns null when allowed, or { status, message }.
 * @param {Object} user - req.user
 * @param {{ modelType: string, modelSize?: string, modelKey?: string, baseModel?: Object|null }} job
 */
async function checkCustomerTraining(user, { modelType, modelSize, modelKey, baseModel }) {
  if (isGsnUser(user)) return null;

  if (baseModel?.linkedFrom) {
    return { status: 403, message: 'Shared GSN sample models can\'t be trained further. Start from a base model instead.' };
  }
  if (!baseModel) {
    const letter = modelType === 'RF_DETR' ? 'n' : sizeLetter(modelSize, modelKey);
    if (!CUSTOMER_MODEL_SIZES.includes(letter)) {
      return { status: 403, message: 'Your workspace can train nano or small models only.' };
    }
  }

  const [own, pending] = await Promise.all([countOwnModels(user.company), countPendingTrainings(user.company)]);
  if (own + pending >= CUSTOMER_MODEL_LIMIT) {
    return {
      status: 403,
      message: `Your workspace can keep ${CUSTOMER_MODEL_LIMIT} trained models. Delete one to train a new one.`,
    };
  }

  const monthlyRuns = user.access?.limits?.trainingRunsPerMonth;
  if (typeof monthlyRuns === 'number' && (await countTrainingRunsThisMonth(user.company)) >= monthlyRuns) {
    return {
      status: 403,
      message: `Your plan includes ${monthlyRuns} training runs a month, and you've used them all. They reset on the 1st.`,
    };
  }
  return null;
}

module.exports = {
  GSN_COMPANY,
  CUSTOMER_MODEL_LIMIT,
  CUSTOMER_MODEL_SIZES,
  isGsnUser,
  customerAccess,
  checkCustomerTraining,
  countOwnModels,
  countPendingTrainings,
};
