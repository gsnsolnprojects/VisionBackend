const mongoose = require('mongoose');

/**
 * Sample library entry
 *
 * One GSN dataset offered to customers (Playground) as a ready-made sample.
 * The superadmin curates the library: display name, industry, description and
 * whether it is shown. Customers pick an entry and get an independent copy of the
 * underlying dataset in their own project.
 */

const SAMPLE_INDUSTRIES = ['Pharma', 'Automotive', 'Electronics', 'Marine & Corrosion', 'General'];

const sampleLibraryItemSchema = new mongoose.Schema(
  {
    // The GSN dataset this entry points to
    datasetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dataset',
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    industry: {
      type: String,
      enum: SAMPLE_INDUSTRIES,
      default: 'General',
    },
    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
    },
    isVisible: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

sampleLibraryItemSchema.index({ isVisible: 1, industry: 1 });

module.exports = mongoose.model('SampleLibraryItem', sampleLibraryItemSchema);
module.exports.SAMPLE_INDUSTRIES = SAMPLE_INDUSTRIES;
