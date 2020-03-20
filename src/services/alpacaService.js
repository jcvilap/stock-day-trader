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

  getInstrumentBySymbol(symbol) {
    return this.alpaca.getAsset(symbol);
  }

  async getAccount() {
    const account = await this._account ?
      Promise.resolve(this._account) :
      this.alpaca.getAccount();

    this._account = account;
    return account;
  }

  getOrders() {
    return this.alpaca.getOrders({});
  }

  placeOrder(options) {
    return this.alpaca.createOrder(options);
  }
}

module.exports = new AlpacaApiService();