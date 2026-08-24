export const RESISTANCE_CITIES = [
  "Tokyo",
  "Berlin",
  "Nairobi",
  "Rio",
  "Denver",
  "Helsinki",
  "Moscow",
  "Oslo",
  "Bogota",
  "Palermo",
  "Stockholm",
  "Lisbon",
  "Marseille",
  "Reykjavik",
  "Valencia",
  "Manila",
  "Cairo",
  "Havana",
  "Vienna",
  "Kyoto",
] as const;

export type ResistanceCity = (typeof RESISTANCE_CITIES)[number];
