import React from "react";

export type HomeFilter = "all" | "desi" | "anime" | "sponsored";

const FILTERS: { id: HomeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "desi", label: "Desi" },
  { id: "anime", label: "Anime" },
  { id: "sponsored", label: "Sponsored" },
];

// Sits between the hero and the "All Videos" heading. It is a filter, not a
// route, so the home page keeps its single address and its single catalog.
const CategoryBar: React.FC<{ value: HomeFilter; onChange: (next: HomeFilter) => void }> = ({ value, onChange }) => (
  <div className="category-bar" role="group" aria-label="Filter the catalogue">
    {FILTERS.map((filter) => (
      <button
        key={filter.id}
        type="button"
        className={`category-bar__chip${value === filter.id ? " is-active" : ""}`}
        aria-pressed={value === filter.id}
        onClick={() => onChange(filter.id)}
      >
        {filter.label}
      </button>
    ))}
  </div>
);

export default CategoryBar;
