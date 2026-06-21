type TokenModelAvailabilityLike = {
  available?: boolean | null;
  message?: string | null;
  httpStatus?: number | null;
  responseText?: string | null;
};

const FAILED_TEST_MESSAGE_PATTERN = /失败|错误|超时|不可用|unauthorized|forbidden|invalid/i;

export function hasManualTokenModelTestRecord(row: TokenModelAvailabilityLike | null | undefined): boolean {
  if (!row) return false;
  return (row.message || '').trim().length > 0
    || row.httpStatus != null
    || (row.responseText || '').trim().length > 0;
}

export function isSuccessfulManualTokenModelTest(row: TokenModelAvailabilityLike | null | undefined): boolean {
  if (!hasManualTokenModelTestRecord(row)) return false;
  const message = (row?.message || '').trim();
  if (row?.httpStatus != null) {
    return row.httpStatus >= 200
      && row.httpStatus < 300
      && !FAILED_TEST_MESSAGE_PATTERN.test(message);
  }
  return /^请求成功$|成功|可用/i.test(message);
}
