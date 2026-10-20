// Licensed-device counts for an account: devices bought with its email (minus any it has assigned
// to team members) plus devices a team owner assigned to it. Assignments are permanent, but they
// end if the order they came from is refunded (they point at that order's licence row).

/** True when the account has at least one active licensed device (own or assigned), or a Deployment Licence. */
export async function hasActiveBusinessLicence(env, user) {
  if (!user) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM licences WHERE email = ?1 AND status = 'active'
       AND (licence_type = 'deployment' OR (licence_type = 'business' AND devices > assigned_devices))
     UNION ALL
     SELECT 1 FROM licence_assignments a JOIN licences l ON l.id = a.licence_id
       WHERE a.user_id = ?2 AND l.status = 'active'
     LIMIT 1`
  ).bind(user.email, user.id).first();
  return !!row;
}

/** Devices assigned to this account, split by team and by whether the source order is still active. */
export async function assignedToUser(env, userId) {
  const { results = [] } = await env.DB.prepare(
    `SELECT a.team_id, l.status, SUM(a.devices) AS devices
     FROM licence_assignments a JOIN licences l ON l.id = a.licence_id
     WHERE a.user_id = ? GROUP BY a.team_id, l.status`
  ).bind(userId).all();
  return results;
}

/** Owner's pool: active Business Licence devices bought with the owner's email. */
export async function poolFor(env, ownerEmail) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(devices), 0) AS total, COALESCE(SUM(assigned_devices), 0) AS assigned
     FROM licences WHERE email = ? AND status = 'active' AND licence_type = 'business'`
  ).bind(ownerEmail).first();
  const total = Number(row?.total || 0);
  const assigned = Number(row?.assigned || 0);
  return { total, assigned, unassigned: Math.max(0, total - assigned) };
}
