/**
 * Conventional Commits (https://www.conventionalcommits.org/), checked on every commit by the commit-msg hook and on
 * every pull request (its commits and its title) in CI. Bodies and footers are prose, so their lines are not wrapped.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
}
