// Sonda di shims.test.js: grid-harness.mjs la compila con il suo
// '@youty/shared' finto (lo SHARED). Le sonde sono due e diverse: due bundle
// uguali sarebbero lo stesso modulo (stesso data: URL), e non si vedrebbe se
// lo SHARED tiene una sola classe ApiError fra componenti diversi.
export * as shared from '@youty/shared';
export const probe = 'b';
