import React, { useState } from "react";
import { Search, X, Menu, Bell, User, ChevronDown } from "lucide-react";
import type { BrowseView } from "../types/navigation";

interface NavbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  activeView: BrowseView;
  onNavigate: (view: BrowseView) => void;
  accountLabel: string;
  accountInitial?: string;
  onAccountClick: () => void;
}

const Navbar: React.FC<NavbarProps> = ({ searchQuery, onSearchChange, onSearchSubmit, activeView, onNavigate, accountLabel, accountInitial, onAccountClick }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  const categories: BrowseView[] = ["Home", "Trending", "New", "Exclusive", "Categories"];
  const navigate = (view: BrowseView) => {
    onNavigate(view);
    setMobileMenuOpen(false);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setMobileMenuOpen(false);
    onSearchSubmit(searchQuery);
  };

  return (
    <nav
      className="site-nav fixed top-0 left-0 right-0 z-50 border-b border-yellow-900/20"
      style={{
        background: "rgba(8,8,8,0.97)",
        backdropFilter: "blur(20px)",
        boxShadow: "0 2px 30px rgba(0,0,0,0.8)",
      }}
    >
      <div className="site-nav__container max-w-[1600px] mx-auto px-4">
        {/* Top bar */}
        <div className="site-nav__bar flex items-center gap-4 h-16">
          {/* Logo */}
          <a href="/" aria-label="Intimora home" className="site-nav__brand flex items-center flex-shrink-0">
            <img src="/logo.svg" alt="" className="site-nav__brand-mark" />
            <span className="site-nav__brand-text brand-wordmark" aria-hidden="true">Intimora</span>
          </a>

          {/* Search bar */}
          <form onSubmit={handleSearch} className="site-nav__search flex-1 max-w-2xl mx-auto">
            <div
              className="flex items-center rounded-full border transition-all duration-300 overflow-hidden"
              style={{
                background: "#111",
                borderColor: searchFocused ? "#c9a84c" : "#2a2a2a",
                boxShadow: searchFocused ? "0 0 15px rgba(201,168,76,0.2)" : "none",
              }}
            >
              <Search className="site-nav__search-icon w-4 h-4 ml-4 flex-shrink-0" style={{ color: "#c9a84c" }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search videos, creators, categories..."
                aria-label="Search videos"
                className="site-nav__input flex-1 px-3 py-2.5 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  aria-label="Clear search"
                  className="site-nav__clear p-2 mr-1 text-gray-500 hover:text-white transition"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="submit"
                aria-label="Search"
                className="site-nav__submit px-4 py-2.5 text-xs font-bold tracking-wider transition-all"
                style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
              >
                <Search className="site-nav__submit-icon hidden w-4 h-4" aria-hidden="true" />
                <span className="site-nav__submit-text">SEARCH</span>
              </button>
            </div>
          </form>

          {/* Right actions */}
          <div className="site-nav__actions flex items-center gap-2 flex-shrink-0">
            <button aria-label="Notifications" className="site-nav__desktop-action p-2 rounded-full text-gray-400 hover:text-yellow-400 transition relative">
              <Bell className="w-5 h-5" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
            </button>
            <button type="button" aria-label={accountLabel} onClick={() => { setMobileMenuOpen(false); onAccountClick(); }} className="site-nav__account rounded-full text-gray-400 hover:text-yellow-400 transition">
              {accountInitial ? <span aria-hidden="true">{accountInitial}</span> : <User className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-navigation"
              className="site-nav__menu-toggle sm:hidden p-2 text-gray-400 hover:text-white"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Category bar */}
        <div className="site-nav__desktop-links hidden sm:flex items-center gap-1 pb-2 overflow-x-auto scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => navigate(cat)}
              aria-current={activeView === cat ? "page" : undefined}
              className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-wider whitespace-nowrap transition-all hover:text-yellow-400"
              style={{ color: activeView === cat ? "#c9a84c" : "#666" }}
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
          <div id="mobile-navigation" className="site-nav__mobile-menu sm:hidden pb-3 border-t border-gray-800 pt-3">
            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => navigate(cat)}
                  aria-current={activeView === cat ? "page" : undefined}
                  className="px-3 py-1.5 rounded-full text-xs font-semibold text-gray-400 hover:text-yellow-400 border border-gray-800 hover:border-yellow-800 transition"
                  style={activeView === cat ? { color: "#f3d58a", borderColor: "#8c6c32" } : undefined}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="site-nav__mobile-actions">
              <button type="button" className="site-nav__mobile-action"><Bell className="w-4 h-4" /> Notifications</button>
              <button type="button" className="site-nav__mobile-action" onClick={() => { setMobileMenuOpen(false); onAccountClick(); }}><User className="w-4 h-4" /> Account</button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
