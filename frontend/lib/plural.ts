// Forms for 1, 2-4, 5+; 11-14 take the 5+ form
export function plural(n: number, forms: [string, string, string]) {
  const tens = n % 100;
  const ones = n % 10;
  const form =
    tens >= 11 && tens <= 14 ? forms[2] : ones === 1 ? forms[0] : ones >= 2 && ones <= 4 ? forms[1] : forms[2];
  return `${n} ${form}`;
}

export function trainingsCount(n: number) {
  return plural(n, ["тренування", "тренування", "тренувань"]);
}
