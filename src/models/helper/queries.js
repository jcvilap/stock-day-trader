const Rule = require('../Rule');
const Trade = require('../Trade');

const getActiveRules = () => Rule
  .find({ enabled: true })
  .populate('strategy.in')
  .populate('strategy.out');

const getActiveRulesByFrequency = (frequency) => Rule
  .find({ enabled: true, frequency })
  .populate('strategy.in')
  .populate('strategy.out');

const getIncompleteTrades = () => Trade
  .find({ completed: false });

module.exports = {
  getActiveRules,
  getIncompleteTrades,
  getActiveRulesByFrequency,
};