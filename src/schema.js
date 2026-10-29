/**
 * Cordis Standard Schema for plugin config (accepts any plain object).
 * Avoids pulling schemastery as a hard dependency.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-jiuwen-adapter',
    validate(value) {
      const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return { value: config }
    },
  },
}
