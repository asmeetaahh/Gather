/** One invalid field in a request, safe to show next to the matching form input. */
export interface FieldError {
  /** The request field, e.g. `playedOn`; `body` when the whole body is unusable. */
  field: string;
  message: string;
}

/** Standard error envelope returned by every failing API response. */
export interface ApiErrorBody {
  error: {
    /** Stable, machine-readable code, e.g. `not_found`. */
    code: string;
    /** Human-readable message that is safe to show to end users. */
    message: string;
    /** Present on validation failures (`validation_failed`): what is wrong with which field. */
    fieldErrors?: FieldError[];
  };
}
