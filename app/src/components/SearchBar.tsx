import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, Loader2 } from "lucide-react";
import { useSearchSuggestions } from "@/hooks/useSearchSuggestions";

interface SearchBarProps {
  initialQuery?: string;
  placeholder?: string;
  onSearch?: (query: string) => void;
  autoFocus?: boolean;
  showButton?: boolean;
  className?: string;
  inputClassName?: string;
}

const SearchBar: React.FC<SearchBarProps> = ({
  initialQuery = "",
  placeholder,
  onSearch,
  autoFocus = false,
  showButton = true,
  className = "",
  inputClassName = "",
}) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // AI-powered search suggestions
  const { data: suggestionsData, isLoading: suggestionsLoading } =
    useSearchSuggestions(searchQuery, 300);

  const suggestions = suggestionsData?.suggestions || [];

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery) {
      if (onSearch) {
        onSearch(trimmedQuery);
      } else {
        navigate(`/search?q=${encodeURIComponent(trimmedQuery)}`);
      }
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    if (onSearch) {
      onSearch(suggestion);
    } else {
      navigate(`/search?q=${encodeURIComponent(suggestion)}`);
    }
    setSearchQuery(suggestion);
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    searchInputRef.current?.blur();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    setShowSuggestions(value.length >= 2);
    setSelectedSuggestionIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedSuggestionIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        if (selectedSuggestionIndex >= 0) {
          e.preventDefault();
          handleSuggestionClick(suggestions[selectedSuggestionIndex]);
        }
        break;
      case "Escape":
        setShowSuggestions(false);
        setSelectedSuggestionIndex(-1);
        break;
    }
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
        setSelectedSuggestionIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Update internal state when initialQuery changes
  useEffect(() => {
    setSearchQuery(initialQuery);
  }, [initialQuery]);

  const defaultPlaceholder = placeholder || t("search.placeholder");

  return (
    <form onSubmit={handleSearch} className={className}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50 z-10" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => searchQuery.length >= 2 && setShowSuggestions(true)}
            placeholder={defaultPlaceholder}
            className={`w-full pl-10 pr-10 py-3 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none ${inputClassName}`}
            autoComplete="off"
            autoFocus={autoFocus}
            data-testid="search-query-input"
          />
          {suggestionsLoading && searchQuery.length >= 2 && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-accent animate-spin" />
          )}

          {/* AI-Powered Suggestions Dropdown */}
          {showSuggestions && suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute z-50 w-full mt-1 bg-white border-2 border-doodle-accent shadow-lg max-h-80 overflow-y-auto"
            >
              <div className="p-2 bg-doodle-accent/10 border-b border-doodle-accent/30 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-doodle-accent" />
                <span className="font-doodle text-xs text-doodle-text font-bold">
                  AI-Powered Suggestions
                </span>
              </div>
              <ul className="py-1">
                {suggestions.map((suggestion, index) => (
                  <li
                    key={index}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={`px-4 py-2 font-doodle text-sm cursor-pointer flex items-center gap-2 transition-colors ${
                      index === selectedSuggestionIndex
                        ? "bg-doodle-accent/20 text-doodle-text"
                        : "hover:bg-doodle-accent/10 text-doodle-text/80"
                    }`}
                  >
                    <Search className="w-4 h-4 text-doodle-text/50 flex-shrink-0" />
                    <span>{suggestion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {showButton && (
          <button
            type="submit"
            className="doodle-button doodle-button-primary px-6 flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            {t("buttons.search")}
          </button>
        )}
      </div>
    </form>
  );
};

export default SearchBar;
