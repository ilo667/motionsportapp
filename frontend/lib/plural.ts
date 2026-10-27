// «1 тренування», «3 тренування», «8 тренувань»
export function trainingsCount(n: number) {
  const tens = n % 100;
  const ones = n % 10;
  return `${n} ${tens < 11 || tens > 14 ? (ones >= 1 && ones <= 4 ? "тренування" : "тренувань") : "тренувань"}`;
}
