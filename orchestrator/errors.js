class NeedsStructuralReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsStructuralReviewError';
  }
}

class GenerationFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenerationFailedError';
  }
}

module.exports = {
  NeedsStructuralReviewError,
  GenerationFailedError
};
