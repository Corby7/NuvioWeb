// Whether IMDb ratings are shown, kept as a named mode rather than a boolean so
// it matches the Android client's `home_imdb_ratings_visibility` settings field
// and can gain a middle option later without a migration.
//
// The setting covers the Home hero rating and the title rating on the detail
// hero. It deliberately does not touch the MDBList ratings row or the detail
// "Ratings" tab: both are surfaces the user opted into explicitly. (Upstream
// also suppresses the standard detail rating whenever MDBList is active; this
// fork resolves MDBList *into* that badge instead, so there is nothing to
// deduplicate.)

export const HOME_IMDB_RATINGS_VISIBILITY = {
  SHOW_ALL: "SHOW_ALL",
  HIDE_ALL: "HIDE_ALL"
};

export function normalizeHomeImdbRatingsVisibility(value) {
  return value === HOME_IMDB_RATINGS_VISIBILITY.HIDE_ALL
    ? HOME_IMDB_RATINGS_VISIBILITY.HIDE_ALL
    : HOME_IMDB_RATINGS_VISIBILITY.SHOW_ALL;
}

export function showImdbRatings(visibility) {
  return normalizeHomeImdbRatingsVisibility(visibility) === HOME_IMDB_RATINGS_VISIBILITY.SHOW_ALL;
}
