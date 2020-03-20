const { IncomingWebhook } = require('@slack/client');
const moment = require('moment');
const { isString, get } = require('lodash');

const { SLACK_LOG_ERROR_WEBHOOK_URL, SLACK_LOG_OTHER_WEBHOOK_URL } = require('../config/env');

class LogService {
  constructor() {
    this.errorLogger = new IncomingWebhook(SLACK_LOG_ERROR_WEBHOOK_URL);
    this.logger = new IncomingWebhook(SLACK_LOG_OTHER_WEBHOOK_URL);
  }

  error(toBeLogged, error = '') {
    const msg = get(toBeLogged, 'message', toBeLogged);
    const err = get(error, 'message', error);
    const stack = get(toBeLogged, 'stack', get(error, 'stack', ''));
    const message = isString(msg) ? msg : this.formatJSON(msg, 0);
    const errorMsg = isString(err) ? err : this.formatJSON(err, 0);
    const finalMessage = `*${message}* ${errorMsg} ${stack}`.trim();
    console.log(finalMessage);
    this.errorLogger.send(finalMessage);
  }

  orderPlaced({ symbol, side, name, created_at = new Date(), price }) {
    const message = `${symbol} | ${side} | ${name} | $${Number(price).toFixed(3)} | ${moment(created_at).format('MM/DD/YY h:mm:ssa')}`;
    this.logger.send(`:rocket: *ORDER PLACED =>* ${message}`);
    console.log(`*ORDER PLACED =>* ${message}`);
  }

  orderCanceled({ symbol, side, name, date = new Date(), price, json }) {
    const message = `${symbol} | ${side} | ${name} | $${Number(price).toFixed(3)} | ${moment(date).format('MM/DD/YY h:mm:ssa')} | ${ this.formatJSON(json, 0)}`;
    this.logger.send(`:skull: *ORDER CANCELED =>* ${message}`);
    console.log(`*ORDER CANCELED =>* ${message}`);
  }

  log(message) {
    this.logger.send(message);
    console.log(message);
  }

  logMeta(trade, quote, rule) {
    console.log(
      `[${rule.name.substring(0, 15)}...]`,
      ' => close:', this.parse(quote.close),
      '| entry:', this.parse(get(trade, 'buyPrice', 0)),
      '| risk:', this.parse(get(trade, 'riskValue', 0)),
      '| profit:', this.parse(get(trade, 'profitValue', 0)),
      '| follow:', get(rule, 'limits.followPrice.enabled', false),
      '| targetReached:', get(trade, 'targetReached', false),
      '| time:', (new Date()).toLocaleTimeString(),
      '\n========================================================================================================================================================='
    );
  }

  ping() {
    const message = `[ping...] | time:${(new Date()).toLocaleTimeString()}`;
    this.logger.send(message);
    console.log(message);
  }

  parse(n) {
    return parseFloat(Math.round(n * 100) / 100).toFixed(2);
  }

  formatJSON(json = {}, spaces = 2) {
    return JSON.stringify(json, null, spaces);
  }
}

module.exports = new LogService();
