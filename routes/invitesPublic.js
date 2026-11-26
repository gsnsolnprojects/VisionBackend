/**
 * Organisation invite links (/auth?invite=<token> in the web app).
 *
 * GET  /api/invites/:token         public: is the invite still valid, and for which organisation
 *                                  (was edge function validate-invite)
 * POST /api/invites/:token/accept  signed in: join the organisation as a viewer
 *                                  (was edge function accept-invite; now uses the signed-in user,
 *                                  not a user id sent in the request body)
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticateToken, invalidateUserCache } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

/** The invite row, or a { status, error } explaining why it can't be used */
async function loadInvite(token) {
  if (!token || String(token).length > 200) return { status: 400, error: 'token required' };
  const invite = await db.one(
    'select id, company_id, email, token, status, expires_at from public.company_invites where token = $1 limit 1',
    [String(token)]
  );
  if (!invite) return { status: 404, error: 'invite not found' };
  if (invite.status === 'accepted') return { status: 400, error: 'invite already accepted', invite };
  if (invite.status === 'revoked') return { status: 400, error: 'invite revoked' };
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { status: 400, error: 'invite expired' };
  return { invite };
}

router.get('/:token', async (req, res) => {
  try {
    const result = await loadInvite(req.params.token);
    if (!result.invite || result.error) return res.status(result.status).json({ ok: false, error: result.error });
    const company = await db.one('select id, name from public.companies where id = $1', [result.invite.company_id]);
    res.json({
      ok: true,
      invite: {
        id: result.invite.id,
        company_id: result.invite.company_id,
        company_name: company?.name ?? null,
        invite_email: result.invite.email,
      },
    });
  } catch (err) {
    console.error('[invites] validate failed:', err);
    res.status(500).json({ ok: false, error: 'Could not check the invite' });
  }
});

router.post('/:token/accept', authenticateToken, async (req, res) => {
  try {
    const result = await loadInvite(req.params.token);
    // Using the same invite twice is a soft success (the app treats it as "already joined")
    if (result.error === 'invite already accepted') return res.json({ ok: false, error: 'invite already accepted' });
    if (!result.invite || result.error) return res.status(result.status).json({ ok: false, error: result.error });
    const { invite } = result;

    const profile = await db.one('select email, company_id from public.profiles where id = $1', [req.user.id]);
    if (!profile) {
      return res.status(404).json({ ok: false, error: 'User profile not found. Please try signing out and signing in again.' });
    }
    if (String(profile.email || '').trim().toLowerCase() !== String(invite.email || '').trim().toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'Email does not match invite' });
    }
    if (profile.company_id && profile.company_id !== invite.company_id) {
      return res.status(400).json({ ok: false, error: 'You already belong to another organisation' });
    }

    await db.asSystem(async (c) => {
      await c.query(`update public.profiles set company_id = $2, role = 'viewer' where id = $1`, [req.user.id, invite.company_id]);
      await c.query(`update public.company_invites set status = 'accepted' where id = $1`, [invite.id]);
    });
    invalidateUserCache(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[invites] accept failed:', err);
    res.status(500).json({ ok: false, error: 'Could not accept the invite' });
  }
});

module.exports = router;
