const mongoose = require('mongoose');

const Trade = new mongoose.Schema({
  /**
   * Price used to enter the trade
   */
  buyPrice: { type: Number },
  buyOrderId: { type: String },
  buyDate: { type: Date },
  createdAt: { type: Date },
  /**
   * Price used to exit the trade
   */
  sellPrice: { type: Number },
  sellOrderId: { type: String },
  sellDate: { type: Date },
  /**
   * Whether the trade has ended
   */
  completed: { type: Boolean, default: false, index: true },
  /**
   * Risk quote price that could trigger a sale
   */
  riskValue: { type: Number, default: 0 },
  /**
   * Quote price that could trigger a sale to lock profits
   */
  profitValue: { type: Number },
  /**
   * Whether the target percentage profit was reached
   */
  targetReached: { type: Boolean, default: false },
  /**
   * Id of the Rule executing the order
   */
  rule: { type: mongoose.Schema.Types.ObjectId, ref: 'Rule', required: true, index: true },
  gainPercent: { type: Number },
  /**
   * Amount of shares filled thus far
   */
  boughtShares: { type: Number, default: 0 },
  soldShares: { type: Number, default: 0 },
}, { versionKey: false });

Trade.index(
  { rule: 1, completed: 1 },
  {
    name: 'unique_incomplete_trade_rule',
    unique: true,
    partialFilterExpression: { completed: false },
  }
);

Trade.pre('save', async function (next) {
  const trade = this;
  const { sellPrice, buyPrice, completed, createdAt } = trade;

  if (completed) {
    trade.gainPercent = ((sellPrice - buyPrice)/buyPrice) * 100;
  }

  if (!createdAt) {
    trade.createdAt = new Date();
  }

  return next();
});

module.exports = mongoose.model('Trade', Trade);
