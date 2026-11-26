/**
 * Account helpers on our own Postgres (replaces services/supabaseService.js; same function names
 * and return shapes so callers didn't have to change).
 */
const db = require('../db');
const { revokeAllSessions } = require('./authService');

/** { id, email, role, company_id, is_active } or null */
async function getUserProfile(userId) {
  try {
    return await db.one('select id, email, role, company_id, is_active from public.profiles where id = $1', [userId]);
  } catch (error) {
    console.error('Error getting user profile:', error.message);
    return null;
  }
}

async function getUserRole(userId) {
  try {
    const row = await db.one('select role from public.profiles where id = $1', [userId]);
    return row ? row.role : null;
  } catch (error) {
    console.error('Error getting user role:', error.message);
    return null;
  }
}

async function updateUserRole(userId, newRole) {
  try {
    await db.query('update public.profiles set role = $2 where id = $1', [userId, newRole]);
    return { success: true };
  } catch (error) {
    console.error('Error updating user role:', error.message);
    return { success: false, error: error.message };
  }
}

/** true = can log in, false = login disabled (signs them out everywhere) */
async function updateUserActive(userId, active) {
  try {
    await db.query('update public.profiles set is_active = $2 where id = $1', [userId, !!active]);
    if (!active) await revokeAllSessions(userId);
    return { success: true };
  } catch (error) {
    console.error('Error updating user active:', error.message);
    return { success: false, error: error.message };
  }
}

/** Delete the login account; the profile goes with it (ON DELETE CASCADE) */
async function deleteAuthUser(userId) {
  try {
    await db.query('delete from auth.users where id = $1', [userId]);
    return { success: true };
  } catch (err) {
    console.error('Error deleting user:', err.message);
    return { success: false, error: err.message };
  }
}

/** Login disabled and removed from their organisation */
async function deactivateAndRemoveFromWorkspace(userId) {
  try {
    await db.query('update public.profiles set is_active = false, company_id = null where id = $1', [userId]);
    await revokeAllSessions(userId);
    return { success: true };
  } catch (error) {
    console.error('Error deactivating/removing user:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a project row by organisation name + project name (so it disappears from the app).
 * Matches the name ignoring surrounding spaces (some projects were saved as e.g. "webcam ").
 */
async function deleteProjectRow(company, project) {
  try {
    const companyRow = await db.one('select id from public.companies where name = $1', [company]);
    if (!companyRow) return { success: false, error: `Organisation "${company}" not found` };
    const { rowCount } = await db.query(
      'delete from public.projects where company_id = $1 and trim(name) = trim($2)',
      [companyRow.id, String(project)]
    );
    return { success: true, deleted: rowCount };
  } catch (error) {
    console.error('Error deleting project row:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  getUserProfile,
  getUserRole,
  updateUserRole,
  updateUserActive,
  deactivateAndRemoveFromWorkspace,
  deleteAuthUser,
  deleteProjectRow,
};
