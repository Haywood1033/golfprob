// GET /api/grades — grade finished events' locked pre-tournament projections and return the
// pooled live track record.
const { gradeAll } = require('../lib/grading');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    send(res, 200, await gradeAll());
  } catch (err) { fail(res, err); }
};
