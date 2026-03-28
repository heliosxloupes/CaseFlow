// In-memory session cache — swap for Redis when scaling beyond one server
const sessions = new Map();

const SESSION_TTL = 25 * 60 * 1000; // 25 minutes (ACGME sessions ~30 min)

function setSession(userId, cookie) {
  sessions.set(userId, { cookie, expiresAt: Date.now() + SESSION_TTL });
}

function getSession(userId) {
  const session = sessions.get(userId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(userId);
    return null;
  }
  return session.cookie;
}

function clearSession(userId) {
  sessions.delete(userId);
}

module.exports = { setSession, getSession, clearSession };
