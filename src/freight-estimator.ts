export type FreightEstimateInput = {
  itemType: string;
  lengthCm: number;
  depthCm: number;
  heightCm?: number;
  levelHeightsCm?: number[];
  quantity?: number;
  packageUnits?: number;
};

export type FreightEstimate = {
  available: boolean;
  confidence: 'medium' | 'caution' | 'insufficient';
  sampleCount: number;
  estimatedWeightMinKg: number | null;
  estimatedWeightMaxKg: number | null;
  chinaFreightMinHkd: number | null;
  chinaFreightMaxHkd: number | null;
  recommendedChinaFreightHkd: number | null;
  hkDeliveryMinHkd: number | null;
  hkDeliveryMaxHkd: number | null;
  recommendedHkDeliveryHkd: number | null;
  note: string;
};

type WeightBand = {
  medianKgPerSquareMetre: number;
  upperKgPerSquareMetre: number;
  sampleCount: number;
  confidence: FreightEstimate['confidence'];
};

/**
 * Non-sensitive aggregate snapshot from June to September 2026.
 *
 * - 24 Order Items had item-level weight input.
 * - Display box: 13 usable dimension/weight samples.
 * - Display Case: 11 usable dimension/weight samples, with a wider spread.
 * - China freight allocation: median HK$9.89/kg and observed high HK$11.09/kg.
 *
 * No Order number, customer data, record ID, address or other business record is
 * stored in this model.  The upper band is deliberately conservative because the
 * UI is an owner warning, not a promise of the carrier's final charge.
 */
export const FREIGHT_ESTIMATOR_MODEL = Object.freeze({
  period: '2026-06_to_2026-09',
  chinaMedianHkdPerKg: 9.89,
  chinaObservedHighHkdPerKg: 11.1,
  chinaRecommendedHkdPerKg: 12,
  chinaMinimumHkd: 80,
  hkBaseWeightKg: 5,
  hkBaseChargeHkd: 100,
  hkAdditionalHkdPerKg: 10,
  displayBox: Object.freeze({
    medianKgPerSquareMetre: 7.6129,
    upperKgPerSquareMetre: 12.2101,
    sampleCount: 13,
    confidence: 'medium' as const,
  }),
  displayCase: Object.freeze({
    medianKgPerSquareMetre: 6.5223,
    upperKgPerSquareMetre: 14.5397,
    sampleCount: 11,
    confidence: 'caution' as const,
  }),
  accessoryPackageUpliftPerExtraUnit: 0.15,
  accessoryPackageUpliftCap: 0.25,
});

const roundOneDecimalUp = (value: number): number => Math.ceil(value * 10) / 10;
const roundTenUp = (value: number): number => Math.ceil(value / 10) * 10;

const finitePositive = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const sixPanelAreaSquareMetres = (lengthCm: number, depthCm: number, heightCm: number): number =>
  (2 * ((lengthCm * depthCm) + (lengthCm * heightCm) + (depthCm * heightCm))) / 10_000;

const localDeliveryFromWeight = (weightKg: number): number => {
  const model = FREIGHT_ESTIMATOR_MODEL;
  if (weightKg <= model.hkBaseWeightKg) return model.hkBaseChargeHkd;
  return model.hkBaseChargeHkd
    + ((weightKg - model.hkBaseWeightKg) * model.hkAdditionalHkdPerKg);
};

const unavailable = (note: string): FreightEstimate => ({
  available: false,
  confidence: 'insufficient',
  sampleCount: 0,
  estimatedWeightMinKg: null,
  estimatedWeightMaxKg: null,
  chinaFreightMinHkd: null,
  chinaFreightMaxHkd: null,
  recommendedChinaFreightHkd: null,
  hkDeliveryMinHkd: null,
  hkDeliveryMaxHkd: null,
  recommendedHkDeliveryHkd: null,
  note,
});

const resolveWeightBand = (itemType: string): WeightBand | null => {
  if (itemType.includes('Display Case')) return FREIGHT_ESTIMATOR_MODEL.displayCase;
  if (itemType.includes('Display box')) return FREIGHT_ESTIMATOR_MODEL.displayBox;
  return null;
};

export const estimateQuoteFreight = (input: FreightEstimateInput): FreightEstimate => {
  const itemType = String(input.itemType || '').trim();
  const band = resolveWeightBand(itemType);
  if (!band) return unavailable('階梯或未有足夠同類歷史重量，請人手確認運費。');

  const lengthCm = finitePositive(input.lengthCm);
  const depthCm = finitePositive(input.depthCm);
  const quantity = Math.max(1, Math.floor(finitePositive(input.quantity) || 1));
  if (!lengthCm || !depthCm) return unavailable('輸入完整尺寸後顯示運費建議。');

  let surfaceAreaSquareMetres = 0;
  let basePackageUnits = quantity;
  if (itemType.includes('Display Case')) {
    const heights = (input.levelHeightsCm || [])
      .map(finitePositive)
      .filter((value): value is number => value !== null);
    if (heights.length === 0) return unavailable('輸入每層內高後顯示運費建議。');
    surfaceAreaSquareMetres = heights.reduce(
      (sum, heightCm) => sum + sixPanelAreaSquareMetres(lengthCm, depthCm, heightCm),
      0,
    ) * quantity;
    basePackageUnits = heights.length * quantity;
  } else {
    const heightCm = finitePositive(input.heightCm);
    if (!heightCm) return unavailable('輸入完整尺寸後顯示運費建議。');
    surfaceAreaSquareMetres = sixPanelAreaSquareMetres(lengthCm, depthCm, heightCm) * quantity;
  }

  const packageUnits = Math.max(basePackageUnits, finitePositive(input.packageUnits) || basePackageUnits);
  const extraPackageRatio = Math.max(0, (packageUnits - basePackageUnits) / basePackageUnits);
  const accessoryUplift = 1 + Math.min(
    FREIGHT_ESTIMATOR_MODEL.accessoryPackageUpliftCap,
    extraPackageRatio * FREIGHT_ESTIMATOR_MODEL.accessoryPackageUpliftPerExtraUnit,
  );

  const estimatedWeightMinKg = roundOneDecimalUp(
    surfaceAreaSquareMetres * band.medianKgPerSquareMetre,
  );
  const estimatedWeightMaxKg = roundOneDecimalUp(
    surfaceAreaSquareMetres * band.upperKgPerSquareMetre * accessoryUplift,
  );

  const chinaFreightMinHkd = roundTenUp(Math.max(
    FREIGHT_ESTIMATOR_MODEL.chinaMinimumHkd,
    estimatedWeightMinKg * FREIGHT_ESTIMATOR_MODEL.chinaMedianHkdPerKg,
  ));
  const chinaFreightMaxHkd = roundTenUp(Math.max(
    FREIGHT_ESTIMATOR_MODEL.chinaMinimumHkd,
    estimatedWeightMaxKg * FREIGHT_ESTIMATOR_MODEL.chinaObservedHighHkdPerKg,
  ));
  const recommendedChinaFreightHkd = roundTenUp(Math.max(
    FREIGHT_ESTIMATOR_MODEL.chinaMinimumHkd,
    estimatedWeightMaxKg * FREIGHT_ESTIMATOR_MODEL.chinaRecommendedHkdPerKg,
  ));
  const hkDeliveryMinHkd = roundTenUp(localDeliveryFromWeight(estimatedWeightMinKg));
  const hkDeliveryMaxHkd = roundTenUp(localDeliveryFromWeight(estimatedWeightMaxKg));

  return {
    available: true,
    confidence: band.confidence,
    sampleCount: band.sampleCount,
    estimatedWeightMinKg,
    estimatedWeightMaxKg,
    chinaFreightMinHkd,
    chinaFreightMaxHkd,
    recommendedChinaFreightHkd,
    hkDeliveryMinHkd,
    hkDeliveryMaxHkd,
    recommendedHkDeliveryHkd: hkDeliveryMaxHkd,
    note: band.confidence === 'caution'
      ? '展示櫃過往重量差距較大，建議價已採用較保守上限。'
      : '按六月至九月相近尺寸及實際重量作保守估算。',
  };
};

export const freightUnderquoteGap = (enteredHkd: unknown, recommendedHkd: unknown): number => {
  const entered = Number(enteredHkd);
  const recommended = Number(recommendedHkd);
  if (!Number.isFinite(entered) || entered <= 0 || !Number.isFinite(recommended) || recommended <= entered) {
    return 0;
  }
  return roundTenUp(recommended - entered);
};
