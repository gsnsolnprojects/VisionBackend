const { createClient } = require('@supabase/supabase-js');

/**
 * Supabase Service
 * 
 * Provides Supabase client instance and helper functions for authentication
 * and user management. This service handles all interactions with Supabase.
 */

let supabaseClient = null;

/**
 * Get or create Supabase client instance
 * Uses service role key for admin operations
 */
function getSupabaseClient() {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase configuration missing. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    }

    supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabaseClient;
}

/**
 * Get user profile from Supabase JWT token
 * 
 * @param {string} token - JWT token from Authorization header
 * @returns {Promise<Object|null>} User profile object or null if invalid
 */
async function getUserFromToken(token) {
  try {
    if (!token) {
      return null;
    }

    const supabase = getSupabaseClient();
    
    // Verify token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return null;
    }

    // Get user profile with role and company_id
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, role, company_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return null;
    }

    return {
      id: profile.id,
      email: profile.email || user.email,
      role: profile.role,
      company_id: profile.company_id
    };
  } catch (error) {
    console.error('Error getting user from token:', error.message);
    return null;
  }
}

/**
 * Get user role from Supabase
 * 
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<string|null>} User role or null if not found
 */
async function getUserRole(userId) {
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return null;
    }

    return data.role;
  } catch (error) {
    console.error('Error getting user role:', error.message);
    return null;
  }
}

/**
 * Update user role in Supabase
 * 
 * @param {string} userId - User ID (UUID)
 * @param {string} newRole - New role to assign
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateUserRole(userId, newRole) {
  try {
    const supabase = getSupabaseClient();
    
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);

    if (error) {
      return {
        success: false,
        error: error.message
      };
    }

    return {
      success: true
    };
  } catch (error) {
    console.error('Error updating user role:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get user profile by ID
 * 
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<Object|null>} User profile or null if not found
 */
async function getUserProfile(userId) {
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, company_id, is_active')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      email: data.email,
      role: data.role,
      company_id: data.company_id,
      is_active: data.is_active
    };
  } catch (error) {
    console.error('Error getting user profile:', error.message);
    return null;
  }
}

/**
 * Update user login access (active/inactive) in Supabase profiles
 * Uses is_active column; default true if column missing is handled by DB.
 *
 * @param {string} userId - User ID (UUID)
 * @param {boolean} active - true = can log in, false = login disabled
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateUserActive(userId, active) {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('profiles')
      .update({ is_active: !!active })
      .eq('id', userId);

    if (error) {
      return {
        success: false,
        error: error.message
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating user active:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Delete user from Supabase Auth (auth.users).
 * Requires service role key. Use after deactivating/removing from workspace.
 * If profiles has ON DELETE CASCADE on auth.users, the profile will be cascade-deleted.
 *
 * @param {string} userId - User ID (UUID, same as auth.users.id)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteAuthUser(userId) {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.admin.deleteUser(userId);

    if (error) {
      return {
        success: false,
        error: error.message
      };
    }

    return { success: true };
  } catch (err) {
    console.error('Error deleting user from Supabase Auth:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Deactivate user and remove from workspace (company)
 * Sets is_active = false and company_id = null so user loses login and is removed from company.
 *
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deactivateAndRemoveFromWorkspace(userId) {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('profiles')
      .update({ is_active: false, company_id: null })
      .eq('id', userId);

    if (error) {
      return {
        success: false,
        error: error.message
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error deactivating/removing user:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Delete project row from Supabase (so project name disappears from frontend UI).
 * Assumes a table named "projects" with columns "company" and "project" (or "name").
 * If your Supabase schema uses different table/column names, update this or call from frontend after our API succeeds.
 *
 * @param {string} company - Company identifier
 * @param {string} project - Project name
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteProjectRow(company, project) {
  try {
    const supabase = getSupabaseClient();
    const { data: companyRow, error: companyError } = await supabase
      .from('companies')
      .select('id')
      .eq('name', company)
      .maybeSingle();
    if (companyError) return { success: false, error: companyError.message };
    if (!companyRow) return { success: false, error: `Company "${company}" not found` };

    // Match the name ignoring surrounding spaces (some projects were saved as e.g. "webcam ")
    const { data: rows, error: listError } = await supabase
      .from('projects')
      .select('id, name')
      .eq('company_id', companyRow.id);
    if (listError) return { success: false, error: listError.message };
    const ids = (rows || []).filter((r) => String(r.name).trim() === String(project).trim()).map((r) => r.id);
    if (ids.length === 0) return { success: true, deleted: 0 }; // already removed (e.g. by the app)

    const { error } = await supabase.from('projects').delete().in('id', ids);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true, deleted: ids.length };
  } catch (error) {
    console.error('Error deleting project row from Supabase:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  getSupabaseClient,
  getUserFromToken,
  getUserRole,
  updateUserRole,
  getUserProfile,
  updateUserActive,
  deactivateAndRemoveFromWorkspace,
  deleteAuthUser,
  deleteProjectRow
};
