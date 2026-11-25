function calculateTotal(expr: string) {
  // INSECURE: eval executes dynamic input as JavaScript code
  return eval(expr);
}
