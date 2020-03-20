const { User } = require('../../models');
const { createJWToken } = require('./auth');

module.exports = async (request, response) => {
  const { username, password } = request.body;

  const user = await User.findOne({ username })
    .catch(e => response.status(401).send({ message: `Authentication failed. Error: ${e}` }));

  if (!user) {
    return response.status(404).send({ message: 'Username not found' });
  }

  const isMatch = await user.comparePassword(password)
    .catch(e => response.status(501).send({ message: e }));

  if (isMatch) {
    const token = createJWToken({ user, expiresIn: 86400000 }); // 1 day
    response.status(200).send({ token });
  } else {
    response.status(401).send({ message: 'Incorrect password' });
  }
};
