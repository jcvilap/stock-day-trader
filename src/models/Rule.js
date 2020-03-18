const mongoose = require('mongoose');
const uuid = require('uuid/v1');
const crypto = require('crypto');
const { getWithAuth, getJSON } = require('../services/rhApiService');
const { getInstrumentBySymbol } = require('../services/alpacaService');
const { ONE_MINUTE, FIVE_SECONDS } = require('../services/utils');

const Rule = new mongoose.Schema({
  /**
   * Rule name
   */
  name: { type: String, required: true },
  /**
   * Stock symbol
   * @example 'SNAP'
   */
  symbol: { type: String, required: true, index: true },
  /**
   * Market exchange
   * @example 'NYSE'
   */
  exchange: { type: String },
  /**
   * Override 3 day-trade per week US rule
   */
  overrideDayTradeChecks: { type: Boolean, default: false },
  /**
   * Instrument in RB
   */
  assetId: { type: String },
  /**
   * Reference uuid to give the broker. User also to filter orders
   */
  refId: { type: String, index: { unique: true } },
  /**
   * Number of shares to trade
   */
  numberOfShares: { type: Number, required: true },
  /**
   * Rule enabled flag
   */
  enabled: { type: Boolean, index: true },
  /**
   * Frequency in which this rule should be executed
   */
  frequency: { type: Number, enum: [ONE_MINUTE, FIVE_SECONDS], index: true, default: ONE_MINUTE },
  /**
   * Limit management
   */
  limits: {
    followPrice: {
      /**
       * Whether to move the risk up as the price rises
       */
      enabled: { type: Boolean, default: false },
      /**
       * Value where after reached, the risk percentage will shortened
       */
      targetPercentage: Number,
      /**
       * Risk set after targetPercentage is reached
       */
      riskPercentageAfterTargetReached: Number
    },
    /**
     * Percentage of the initial value to risk off
     */
    riskPercentage: { type: Number, default: 1 },
    /**
     * Percentage of the initial value to profit off
     */
    profitPercentage: { type: Number, default: null },
  },
  /**
   * If true, rule becomes disabled after a sell happens
   */
  disableAfterSold: { type: Boolean, default: true },
  /**
   * Whether to hold the stock overnight or sell all shares before market closes
   */
  holdOvernight: { type: Boolean, default: true },
  strategy: {
    /**
     * Pattern to enter a trade
     */
    in: { type: mongoose.Schema.Types.ObjectId, ref: 'Pattern' },
    /**
     * Pattern to exit a trade
     */
    out: { type: mongoose.Schema.Types.ObjectId, ref: 'Pattern' },
  }
}, { versionKey: false });

// region HOOKS
/**
 * Populates refId, assetId if not present
 */
Rule.post('save', async function (doc) {
  if (!(doc.refId && doc.assetId)) {
    if (!doc.refId) {
      doc.set('refId', crypto.randomBytes(6).toString('hex'));
    }

    if (!doc.assetId) {
      const instrument = await getInstrumentBySymbol(doc.symbol);
      doc.set('assetId', instrument.id);

      if (!doc.exchange) {
        const market = await getJSON(instrument.market);
        doc.set('exchange', market.acronym);
      }
    }
    await doc.save();
  }
});
// endregion

// region METHODS
/**
 * Generates UUID bound to rule
 * @return {string|null}
 */
Rule.methods.UUID = function () {
  if (this.refId) {
    const uuidParts = uuid().toString().split('-');
    const lastIndex = uuidParts.length - 1;
    uuidParts[lastIndex] = this.refId;

    return uuidParts.join('-');
  }

  return null;
};
// endregion

module.exports = mongoose.model('Rule', Rule);
