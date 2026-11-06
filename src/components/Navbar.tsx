import React, { useState } from "react";
import { Search, X, Menu, Bell, User, ChevronDown } from "lucide-react";

interface NavbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
}

const Navbar: React.FC<NavbarProps> = ({ searchQuery, onSearchChange, onSearchSubmit }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  const categories = ["Home", "Trending", "New", "Premium", "Exclusive", "Categories"];

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchSubmit(searchQuery);
  };

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 border-b border-yellow-900/20"
      style={{
        background: "rgba(8,8,8,0.97)",
        backdropFilter: "blur(20px)",
        boxShadow: "0 2px 30px rgba(0,0,0,0.8)",
      }}
    >
      <div className="max-w-[1600px] mx-auto px-4">
        {/* Top bar */}
        <div className="flex items-center gap-4 h-16">
          {/* Logo */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <img src="/logo.png" alt="Intimora" className="w-9 h-9 object-contain" />
            <span
              className="text-xl font-black tracking-widest hidden sm:block"
              style={{ color: "#c9a84c", fontFamily: "Georgia, serif" }}
            >
              INTIMORA
            </span>
          </div>

          {/* Search bar */}
          <form onSubmit={handleSearch} className="flex-1 max-w-2xl mx-auto">
            <div
              className="flex items-center rounded-full border transition-all duration-300 overflow-hidden"
              style={{
                background: "#111",
                borderColor: searchFocused ? "#c9a84c" : "#2a2a2a",
                boxShadow: searchFocused ? "0 0 15px rgba(201,168,76,0.2)" : "none",
              }}
            >
              <Search className="w-4 h-4 ml-4 flex-shrink-0" style={{ color: "#c9a84c" }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search videos, creators, categories..."
                className="flex-1 px-3 py-2.5 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  className="p-2 mr-1 text-gray-500 hover:text-white transition"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="submit"
                className="px-4 py-2.5 text-xs font-bold tracking-wider transition-all"
                style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
              >
                SEARCH
              </button>
            </div>
          </form>

          {/* Right actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button className="hidden sm:flex items-center gap-1 px-4 py-2 rounded-full text-xs font-bold tracking-wider transition-all hover:scale-105"
              style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}>
              👑 PREMIUM
            </button>
            <button className="p-2 rounded-full text-gray-400 hover:text-yellow-400 transition relative">
              <Bell className="w-5 h-5" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
            </button>
            <button className="p-2 rounded-full text-gray-400 hover:text-yellow-400 transition">
              <User className="w-5 h-5" />
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="sm:hidden p-2 text-gray-400 hover:text-white"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Category bar */}
        <div className="hidden sm:flex items-center gap-1 pb-2 overflow-x-auto scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat}
              className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-wider whitespace-nowrap transition-all hover:text-yellow-400"
              style={{ color: cat === "Home" ? "#c9a84c" : "#666" }}
            >
              {cat === "Categories" ? (
                <span className="flex items-center gap-1">
                  {cat} <ChevronDown className="w-3 h-3" />
                </span>
              ) : (
                cat
              )}
            </button>
          ))}
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden pb-3 border-t border-gray-800 pt-3">
            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => (
                <button
                  key={cat}
                  className="px-3 py-1.5 rounded-full text-xs font-semibold text-gray-400 hover:text-yellow-400 border border-gray-800 hover:border-yellow-800 transition"
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
