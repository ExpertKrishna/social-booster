const mongoose = require('mongoose');

/**
 * Order lifecycle:
 *  pending    -> created / waiting for payment verification
 *  processing -> payment approved, sent to SMM provider
 *  completed  -> provider finished delivery
 *  failed     -> provider call failed or order cancelled (can be retried by admin)
 */
const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    platform: { type: String, required: true },
    service: { type: String, required: true },
    profileLink: { type: String, required: true, trim: true, maxlength: 300 },
    packageType: { type: String, enum: ['standard', 'refill'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    totalPrice: { type: Number, required: true, min: 0 },
    // No default on purpose: the unique+sparse index ignores orders without a UTR.
    paymentUtr: { type: String, unique: true, sparse: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true
    },
    providerOrderId: { type: String },
    providerError: { type: String }
  },
  { timestamps: true } // createdAt = order timestamp, updatedAt auto-managed
);

module.exports = mongoose.model('Order', orderSchema);
