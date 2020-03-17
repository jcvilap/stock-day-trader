const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('../config/env');

const alpaca = new Alpaca({
  keyId: config.ALPACA_API_KEY,
  secretKey: config.ALPACA_API_SECRET_KEY,
  paper: true, // <- true for now
});

module.export = alpaca;