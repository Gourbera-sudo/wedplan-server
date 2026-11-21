/** The six public service categories, in canonical display order. */
export const SERVICE_CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];

export function isServiceCategory(value) {
  return SERVICE_CATEGORIES.includes(value);
}
