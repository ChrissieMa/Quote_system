export const INNER_DIMENSION_BASIS = '內尺寸為準' as const;
export const OUTER_DIMENSION_BASIS = '外尺寸為準' as const;

export type DimensionBasis = typeof INNER_DIMENSION_BASIS | typeof OUTER_DIMENSION_BASIS;

export const normalizeDimensionBasis = (value: unknown): DimensionBasis =>
  String(value || '').trim() === OUTER_DIMENSION_BASIS
    ? OUTER_DIMENSION_BASIS
    : INNER_DIMENSION_BASIS;

export const storedDimensionBasis = (value: unknown): DimensionBasis | '' => {
  const text = String(value || '').trim();
  if (text === INNER_DIMENSION_BASIS || text === OUTER_DIMENSION_BASIS) return text;
  return '';
};
