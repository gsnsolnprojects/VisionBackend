const { getSupabaseClient } = require('../services/supabaseService');
const { PLANS, PLAN_ORDER } = require('../utils/plans');
const { countActiveLiveStreams } = require('./inferenceController');

/**
 * Subscription Controller
 *
 * GET /api/subscription
 * Returns the plan catalogue, the caller's company subscription, what the company
 * may currently do (access) and how much of each limit it is using.
 */
const getSubscription = async (req, res) => {
  try {
    const { company_id: companyId, company, subscription, access } = req.user;
    const plans = PLAN_ORDER.map((id) => PLANS[id]);

    if (!companyId) {
      return res.json({ plans, subscription: null, access, usage: null });
    }

    const supabase = getSupabaseClient();
    const [members, projects] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('projects').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    ]);
    if (members.error) throw members.error;
    if (projects.error) throw projects.error;

    res.json({
      plans,
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            isUnlimited: subscription.is_unlimited,
          }
        : null,
      access,
      usage: {
        users: members.count || 0,
        projects: projects.count || 0,
        liveCameraStreams: countActiveLiveStreams(company),
      },
    });
  } catch (error) {
    console.error('Error loading subscription:', error);
    res.status(500).json({ error: 'Failed to load subscription', message: error.message });
  }
};

module.exports = {
  getSubscription,
};
