"use strict";

// 判定规则模块：原钟表走时调校相关判定。
function latestRetest(db, clockId) {
  return (
    db.retests
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null
  );
}

function latestAdjustment(db, clockId) {
  return (
    db.adjustments
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

// 钟表综合视图：走时调校状态 + 防水压检交付状态，保证各处看到的交付状态一致
function clockSummary(db, clock, pressureRules) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const delivery = pressureRules.clockDeliveryState(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    deliveryStatus: delivery.status,
    deliveryStatusLabel: delivery.statusLabel,
    admitted: delivery.admitted,
    deliveryBlockers: delivery.blockers,
    openOrderId: delivery.orderId || null
  };
}

module.exports = { latestRetest, latestAdjustment, clockSummary };
