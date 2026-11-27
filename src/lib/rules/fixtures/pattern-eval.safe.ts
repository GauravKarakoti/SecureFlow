function calculateTotal(expr: string) {
  // SAFE: JSON.parse safely deserializes structured JSON without execution
  return JSON.parse(expr);
}
