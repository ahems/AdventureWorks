This app (./app) needs a full suite of Playwright tests under ./tests to validate that when a new deployment created by azd up , everything got loaded and installed correctly as well as finding any bugs in the UI we havn't fixed yet. For testing data, we need to use the grounding data from the Original AdventureWorks database in folder ./scripts/sql/_.csv, all of which should be loaded in, and in particular the _-ai\*.csv files as these are additive to the AdventureWorks data and should have all been imported by the azd scripts prior to running these test and we want to make sure that worked.

For the csv files with AI in the name, we should validate it's all there and matches.

For images, we just need to check they are shown.

The tests should all be run against the Azure infra that gets stood up by the bicep so we should get the values for the URL's for the DAB API (for validiting data is in the Database correctly) and the front end app (for making sure it's using the DAB API correctly) from azd env values.

We don't need to verify the infra is deployed correctly.

Initial tests should create a new user (use faker tool to make user data), use the Account page features and then have the user randomly wander around some categories and products of the site, looking at them like a real user might. Add some randomly selected products to thier cart.

Tests that use the AI features like Search (embeddings) and the AI chat should be done last.

We do not need to test the "Wishlist" feature at all as that might get removed.

Make sure the app pages being tested have all the required htmlFor/id pairs etc. needed by Playwright to run the tests correctly before running the tests; many of these were found to be missing in the first tests we created so were failing for this reason so we should proactively fix those.

We do also need to test the Internationalization features of the site so languages should change on every page, no missing keys. We don't need to check the actual translations are right just that they appear to be in the right language. This also applies to the units for currency and dimensions - those should all update when the user changes language.

IMPORTANT: The "Checkout" flow test needs special consideration, as we need control of the email address that the order confirmation is sent to. The test should pull the value of the email that is used for Order Confirmation from an env var called "TEST_EMAIL" so do azd env get-value "TEST_EMAIL". Fail if the returned value containers the word "ERROR" as that means it wasn't set. If it's set, use this value in the test under "Contact Email for Order confirmation" instead of the users' randomly created Primary or any secondary email the test user might have. Do not send emails to any email address that is not the TEST_EMAIL as we don't want to be spamming strangers!

URL's to use:

azd env get-value "VITE_API_FUNCTIONS_URL"
azd env get-value "VITE_API_URL"
azd env get-value "APP_REDIRECT_URI"

You can deploy the app yourself with azd deploy app.
