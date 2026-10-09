'use strict';

const MAIL_COM_STAGES = Object.freeze({
  UNREGISTERED: 'unregistered',
  REFINING: 'refining',
  ELIGIBILITY: 'eligibility',
  PAYMENT_METHOD: 'payment_method',
  GCASH: 'gcash',
  PAID: 'paid',
  SMS: 'sms',
  PENDING_PAYMENT: 'pending_payment',
  COMPLETED: 'completed',
  SOLD: 'sold',
});

module.exports = { MAIL_COM_STAGES };
