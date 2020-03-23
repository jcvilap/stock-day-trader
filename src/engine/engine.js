const { get, uniq, isString, set } = require('lodash');
const moment = require('moment');
const { Query } = require('mingo');
const Order = require('../entities/Order');

const { Trade, queries: { getActiveRulesByFrequency, getIncompleteTrades } } = require('../models');
const tv = require('../services/tvApiService');
const logger = require('../services/logService');

const alpaca = require('../services/alpacaService');

const {
  assert,
  parsePattern,
  getValueFromPercentage,
  FIVE_SECONDS,
  ONE_MINUTE,
} = require('../services/utils');

// Todo: maybe move constants to `process.env.js`?
const OVERRIDE_MARKET_CLOSE = false;
const MANUALLY_SELL_ALL = false;
const DEBUG_MODE = true;
const ENV = 'production';

class Engine {
  constructor() {
    this.orderPendingMap = new Map();
    this.userAccount = null;
    this.marketHours = {};
    this.user = null;
    this.rules = {
      [FIVE_SECONDS]: [],
      [ONE_MINUTE]: [],
    };
  }

  async start() {
    try {
      await this.populateMarketHours();
      await this.loadAccount();
      await this.loadRulesAndAccounts(FIVE_SECONDS);
      await this.loadRulesAndAccounts(ONE_MINUTE);
      await this.detectIntervalChange();

      setInterval(() => this.populateMarketHours(), FIVE_SECONDS);
      setInterval(() => this.loadRulesAndAccounts(FIVE_SECONDS), FIVE_SECONDS);
      setInterval(() => this.loadRulesAndAccounts(ONE_MINUTE), ONE_MINUTE);
      setInterval(() => this.processFeeds(FIVE_SECONDS), FIVE_SECONDS);
      setInterval(() => this.processFeeds(ONE_MINUTE), ONE_MINUTE);

      logger.log('Engine started.');
      this.ping();
    } catch (error) {
      logger.error(error);
    }
  }

  loadAccount() {
    return alpaca.getAccount().then((account) => this.userAccount = account);
  }


  /**
   * Prepares user objects for use on @method processFeeds.
   * Steps include:
   * - Get fresh rules and users from DB
   * - Get or refresh(after 5h) user tokens
   * - Get or refresh(after 10m) user accounts
   * - Get fresh user orders
   * @returns {Promise<void>}
   */
  async loadRulesAndAccounts(frequency, overrideMarketClosed = OVERRIDE_MARKET_CLOSE) {
    const { isClosedNow } = this.marketHours;

    if (!overrideMarketClosed && isClosedNow) {
      return;
    }

    // Fetch fresh rules
    this.rules[frequency] = await getActiveRulesByFrequency(frequency);
    const allRules = [...this.rules[FIVE_SECONDS], ...this.rules[ONE_MINUTE]];

    // Populate refId if not ready
    allRules.forEach(async rule => {
      if (!(rule.refId && rule.assetId)) {
        await rule.save();
      }
    });

    // Append rule orders by refId
    const orderPromises = this.rules[frequency].map((rule, index) => {
      return this.getRuleOrders(rule)
        .then((orders = []) => {
          if (orders.length) {
            set(this.rules, `${frequency}.${index}.orders`, orders);
          }
        });
    });

    return Promise.all(orderPromises).catch(error => logger.error(error));
  }

  async processFeeds(frequency) {
    try {
      const { isClosedNow, secondsLeftToMarketClosed } = this.marketHours;
      const secondsToMarketClosed = secondsLeftToMarketClosed;
      this.rules[frequency] = this.rules[frequency].filter(r => r.enabled && !this.orderPendingMap.has(r._id.toString()));
      const rules = this.rules[frequency];

      if ((!OVERRIDE_MARKET_CLOSE && isClosedNow) || !rules.length) {
        return;
      }

      const symbols = uniq(rules.map(r => `${r.exchange}:${r.symbol}`));
      const [quotes, trades] = await Promise.all([tv.getQuotes(...symbols), getIncompleteTrades()]);
      const promises = [];

      const processRulesPromises = rules.map(async (rule, ruleIndex) => {
        try {
          const quote = quotes.find(q => q.symbol === `${rule.exchange}:${rule.symbol}`);
          assert(quote, `Quote for ${rule.symbol} not found`);

          let trade = trades.find(trade => rule._id.equals(trade.rule));
          let lastOrderIsSell = !trade;
          let lastOrderIsBuy = null;

          /**
           * Trade management
           */
          if (trade) {
            const lastOrderId = get(trade, 'sellOrderId') || get(trade, 'buyOrderId');
            assert(lastOrderId, `Trade without sellOrderId or buyOrderId found. Id: ${trade._id}`);

            let lastOrder = get(rule, 'orders', []).find(({ id }) => id === lastOrderId);
            if (!lastOrder) {
              // Get fresh rule orders
              [rule.orders, lastOrder] = await Promise.all([
                this.getRuleOrders(rule),
                alpaca.getOrder(lastOrderId),
              ]);
            }
            lastOrder = new Order(lastOrder);
            assert(lastOrder, `Fatal error. Order not found for order id: ${lastOrderId} and trade id: ${trade._id}`);

            const lastOrderIsFilled = lastOrder.isFilled || lastOrder.isPartiallyFilled;
            lastOrderIsSell = lastOrderId === get(trade, 'sellOrderId');
            lastOrderIsBuy = lastOrderId === get(trade, 'buyOrderId');

            if (lastOrderIsFilled) {
              const price = lastOrder.filledPrice;
              const date = lastOrder.lastUpdateDate;

              if (lastOrderIsBuy && !trade.buyPrice) {
                trade.buyPrice = price;
                trade.buyDate = date;
                trade.riskValue = getValueFromPercentage(price, rule.limits.riskPercentage, 'risk');
                trade.profitValue = getValueFromPercentage(price, rule.limits.profitPercentage, 'profit');
                trade.boughtShares = lastOrder.boughtShares;

                // Partially filled buy orders will cancel unfilled shares
                if (trade.boughtShares < rule.numberOfShares) {
                  const canceledSuccessfully = await this.cancelLastOrder(lastOrder, rule.symbol, rule.name);
                  assert(canceledSuccessfully, `Failed to cancel partial buy order: ${lastOrder.id}`);
                }
              } else if (lastOrderIsSell) {
                trade.soldShares = lastOrder.boughtShares;

                // Partially filled sell orders will cancel unfilled shares and try to resell
                if (trade.soldShares < trade.boughtShares) {
                  const canceledSuccessfully = await this.cancelLastOrder(lastOrder, rule.symbol, rule.name);
                  assert(canceledSuccessfully, `Failed to cancel partial sell  order: ${lastOrder.id}`);
                } else {
                  trade.sellPrice = price;
                  trade.sellDate = date;
                  trade.completed = true;

                  // Save and close trade
                  await trade.save();

                  // Reset trade vars
                  trade = null;
                  lastOrder = null;

                  // Exit if rule has no strategy to continue
                  if (rule.disableAfterSold || !rule.strategy.in) {
                    rule.enabled = false;
                    this.rules[frequency][ruleIndex].enabled = false;
                    await rule.save();

                    return;
                  }
                }
              }
            }
            // Cancel pending(non-filled) order
            else {
              const canceledSuccessfully = await this.cancelLastOrder(lastOrder, rule.symbol, rule.name);
              assert(canceledSuccessfully, `Failed to cancel order: ${lastOrder.id}`);

              if (lastOrderIsBuy) {
                // Clean up trade after canceled order
                await trade.remove();

                trade = null;
                lastOrderIsBuy = false;
                lastOrderIsSell = true;
              } else if (lastOrderIsSell) {
                trade.sellPrice = undefined;
                trade.sellDate = undefined;
                trade.sellOrderId = undefined;
                trade.completed = false;

                lastOrderIsBuy = true;
                lastOrderIsSell = false;
              }
            }
          }

          if (DEBUG_MODE) {
            logger.logMeta(trade, quote, rule);
          }

          let numberOfShares;
          if (get(trade, 'soldShares') && get(trade, 'soldShares') < get(trade, 'boughtShares')) {
            numberOfShares = get(trade, 'boughtShares') - get(trade, 'soldShares');
            // Partial sell fill occurred, treat the trade as a buy
            lastOrderIsBuy = true;
          } else if (get(trade, 'boughtShares')) {
            // When boughtShares is populated, we want to sell that same number
            numberOfShares = get(trade, 'boughtShares');
          } else {
            // No trade yet, get number of shares from rule
            numberOfShares = get(rule, 'numberOfShares');
          }

          const { symbol, holdOvernight } = rule;
          const price = quote.close;
          const metadata = { ...rule.toObject(), ...this.user, ...quote };
          const buyQuery = new Query(parsePattern(get(rule, 'strategy.in.query'), metadata, false));
          const sellQuery = new Query(parsePattern(get(rule, 'strategy.out.query'), metadata, true));
          assert(buyQuery.__criteria || sellQuery.__criteria, `No strategy found for rule ${rule._id}`);

          const riskValue = get(trade, 'riskValue', 0);
          const profitValue = get(trade, 'profitValue', null);
          const riskPriceReached = riskValue > price;
          const profitPriceReached = profitValue && profitValue < price;
          const commonOptions = { user: this.user, symbol, price, numberOfShares, rule, trade };

          /**
           * End of day is approaching (4PM EST), sell all shares in the last 30sec if rule is not holding overnight
           */
          if (MANUALLY_SELL_ALL || !OVERRIDE_MARKET_CLOSE &&
            (secondsToMarketClosed < 30 && !holdOvernight)) {
            if (lastOrderIsBuy) {
              promises.push(this.placeOrder({
                ...commonOptions,
                side: 'sell',
                name: `${get(rule, 'name')}(${MANUALLY_SELL_ALL ? 'Manual sell' : 'Sell before market is closed'})`,
              }));
            }
            // Exit at this point
            return;
          }

          /**
           * BUY pattern
           */
          if (lastOrderIsSell && buyQuery.test(metadata)) {
            promises.push(this.placeOrder({
              ...commonOptions,
              side: 'buy',
              name: get(rule, 'name'),
            }));
          }

          /**
           * SELL pattern
           */
          else if (lastOrderIsBuy && (riskPriceReached || profitPriceReached || sellQuery.test(metadata))) {
            let name = get(rule, 'name');

            if (riskPriceReached) {
              name += '(Risk reached)';
            } else if (profitPriceReached) {
              name += '(Profit reached)';
            }

            promises.push(this.placeOrder({
              ...commonOptions,
              side: 'sell',
              name,
            }));
          }

          /**
           * Follow price logic
           */
          else if (lastOrderIsBuy && get(trade, 'buyPrice') && rule.limits.followPrice.enabled) {
            const buyPrice = get(trade, 'buyPrice');
            const realizedGainPerc = ((price - buyPrice) / buyPrice) * 100;
            const { riskPercentage, followPrice } = rule.limits;
            const { targetPercentage, riskPercentageAfterTargetReached } = followPrice;

            if (!trade.targetReached && targetPercentage <= realizedGainPerc) {
              trade.targetReached = true;
            }

            if (trade.targetReached) {
              // Target price is reached, use riskPercentageAfterTargetReached as new risk limit
              const newRiskValue = getValueFromPercentage(price, riskPercentageAfterTargetReached, 'risk');
              // Increase risk value only if the new risk is higher
              if (newRiskValue > riskValue) {
                trade.riskValue = newRiskValue;
              }
            } else if (realizedGainPerc > (riskPercentage / 2)) {
              // Gains are higher than half the risk taken
              const newRiskValue = getValueFromPercentage(price, riskPercentage, 'risk');
              // Increase risk value only if the new risk is higher
              if (newRiskValue > riskValue) {
                trade.riskValue = newRiskValue;
              }
            }
          }

          if (trade && trade.isModified()) {
            promises.push(trade.save());
          }
        } catch (error) {
          logger.error(error);
        }
      });

      return Promise.all([...promises, ...processRulesPromises]);
    } catch (error) {
      logger.error(error);
    }

    return Promise.resolve();
  }

  /**
   * Helper function to fetch orders associated with a rule
   * @note Move into a helper service
   * @param rule
   * @returns {Promise<PromiseLike | never>}
   */
  getRuleOrders(rule) {
    return alpaca.getOrders()
      .then((orders = []) => orders
        .filter(o => isString(o.ref_id) && o.ref_id.endsWith(rule.refId)))
      .catch(error => {
        if (get(error, 'message').includes('Request was throttled')) {
          return [];
        }
        logger.error(error);
      });
  }

  /**
   * Cancels pending order
   * @param lastOrder
   * @param name
   * @param symbol
   * @returns {Promise}
   */
  cancelLastOrder(lastOrder, symbol, name) {
    if (lastOrder.isCancelled) {
      return Promise.resolve(true);
    }

    if (lastOrder.isFilled) {
      return alpaca.cancelOrder(lastOrder.id)
        .then(json => {
          logger.orderCanceled({ ...lastOrder.order, symbol, name, json });
          return true;
        })
        .catch(() => false);
    }

    return Promise.resolve(false);
  }

  /**
   * Cancels pending orders and places sell order
   * @param side
   * @param user
   * @param name
   * @param symbol
   * @param price
   * @param numberOfShares
   * @param rule
   * @param trade
   * @returns {Promise}
   */
  async placeOrder({ side, user, symbol, price, numberOfShares, rule, name, trade }) {
    const ruleId = rule._id.toString();
    if (!ruleId || this.orderPendingMap.has(ruleId)) {
      return;
    }

    let finalPrice;
    if (side === 'buy') {
      // Buy 0.01% higher than market price to get an easier fill
      finalPrice = (Number(price) * 1.0001).toFixed(2).toString();
    } else {
      // Sell 0.01% lower than market price to get an easier fill
      finalPrice = (Number(price) * 0.9999).toFixed(2).toString();
    }

    const options = {
      symbol,
      qty: numberOfShares,
      side,
      type: 'limit',
      time_in_force: 'gtc',
      limit_price: finalPrice,
      client_order_id: rule.UUID(),
    };
    const promise = alpaca.placeOrder(options)
      .then(order => {
        logger.orderPlaced({ symbol, price, ...order, name });

        // Update order id on trade
        if (side === 'buy') {
          if (!trade) {
            trade = new Trade({ rule: ruleId });
          }
          trade.buyOrderId = order.id;
        } else {
          trade.sellOrderId = order.id;
        }

        this.orderPendingMap.delete(ruleId);
        return trade.save();
      })
      .catch(async error => {
        const promises = [];
        if ((get(error, 'message', '').includes('Not enough shares to sell'))) {
          const positions = get(user, 'positions', []).find(p => p.instrument === rule.instrumentUrl);
          if (!Number(get(positions, 'quantity', 0))) {
            if (rule.disableAfterSold || !rule.strategy.in) {
              rule.enabled = false;
              promises.push(rule.save());
            }
            trade.sellOrderId = 'not-captured';
            trade.completed = true;
            trade.sellPrice = price;
            trade.sellDate = new Date();
            promises.push(trade.save());
          }
        } else if ((get(error, 'message', '').includes('Instrument cannot be traded'))) {
          rule.enabled = false;
          promises.push(rule.save());
        }
        if (promises.length) {
          await Promise.all(promises);
        }

        this.orderPendingMap.delete(ruleId);
        logger.error({ message: `Failed to place order for rule ${name}. ${error.message}` });
      });

    this.orderPendingMap.set(ruleId, promise);

    return promise;
  }

  /**
   * Awaits until a change in the quote's price is detected
   * @returns {Promise}
   */
  async detectIntervalChange() {
    let prices = null;
    let changeDetected = false;
    while (!changeDetected) {
      const symbols = uniq(this.rules[FIVE_SECONDS].map(r => `${r.exchange}:${r.symbol}`));
      const quotes = await tv.getQuotes(...symbols);
      const currentPrices = quotes.map(quote => quote.close);

      if (!prices) {
        prices = currentPrices;
      }

      changeDetected = currentPrices !== prices;
    }
  }

  /**
   * Populates the engine with current market hours
   * @returns {Promise<void>}
   */
  async populateMarketHours() {
    this.marketHours = await alpaca.getMarketHours();
  }

  /**
   * Ping only when market is open or every half an our when market is closed
   * @returns {Promise<void>}
   */
  async ping() {
    if (ENV === 'production') {
      setInterval(async () => {
        const { isClosedNow } = this.marketHours;
        if (!isClosedNow || moment().minutes() % 30 === 0) {
          logger.ping();
        }
      }, ONE_MINUTE);
    }
  }
}

module.exports = new Engine();
