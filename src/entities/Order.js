const { get } = require('lodash');

class Order {
    
  constructor(orderObj) {
    this.order = orderObj;
  }
    
  _getStatus() {
    return get(this.order, 'status');
  }

  get isFilled() {
    return this._getStatus() === 'filled';
  }

  get isPartiallyFilled() {
    return this._getStatus() === 'partially_filled';
  }

  get isCancelled() {
    return this._getStatus() === 'cancelled';
  }

  get filledPrice() {
    return Number(get(this.order, 'filled_avg_price'));
  }

  get lastUpdateDate() {
    return Date(get(this.order, 'updated_at'));
  }

  get boughtShares() {
    return Number(get(this.order, 'qty'));
  }

  get id() {
    return this.order.id;
  }
}

module.exports = Order;