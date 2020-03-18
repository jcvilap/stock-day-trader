const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('../config/env');
const Utils = require('./utils');

class AlpacaApiService {

  constructor() {
    this.alpaca = new Alpaca({
      keyId: config.ALPACA_API_KEY,
      secretKey: config.ALPACA_API_SECRET_KEY,
      paper: true, // <- true for now
    });
  }

  async getMarketHours() {
    const clockData = await this.alpaca.getClock();
    return Utils.marketTimes(clockData);
  }
}

module.export = new AlpacaApiService();