const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { API_PORT } = require('./../config/env');
const jwt = require('./middlewares/jwt');
const rules = require('./rules');
const trades = require('./trades');
const patterns = require('./patterns');
const authenticate = require('./middlewares/authenticate');

module.exports = () => {
  const api = express();

  api.use(bodyParser.json());
  api.use(bodyParser.urlencoded({ extended: false }));
  api.use(cors());
  api.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'X-Total-Count');
    next();
  });

  api.post('/api/v1/login', authenticate);

  api.use(jwt);

  api.get('/api/v1/rules', rules.list);
  api.get('/api/v1/trades', trades.list);
  api.get('/api/v1/patterns', patterns.list);

  api.get('/api/v1/rules/:id', rules.getOne);
  api.get('/api/v1/trades/:id', trades.getOne);
  api.get('/api/v1/patterns/:id', patterns.getOne);

  api.post('/api/v1/rules', rules.create);
  api.post('/api/v1/trades', trades.create);
  api.post('/api/v1/patterns', patterns.create);

  api.patch('/api/v1/rules/:id', rules.update);
  api.patch('/api/v1/trades/:id', trades.update);
  api.patch('/api/v1/patterns/:id', patterns.update);

  api.delete('/api/v1/rules/:id', rules.remove);
  api.delete('/api/v1/trades/:id', trades.remove);
  api.delete('/api/v1/patterns/:id', patterns.remove);

  api.delete('/api/v1/rules', rules.deleteMany);
  api.delete('/api/v1/trades', trades.deleteMany);
  api.delete('/api/v1/patterns', patterns.deleteMany);

  api.listen(API_PORT, () => console.debug(`Database connected. API running on port ${API_PORT}`));
};

