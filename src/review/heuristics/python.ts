import type { Heuristic } from "./index";

/**
 * Python-specific review hints.
 *
 * Text-level pointers for the LLM reviewer. The LLM should look for these
 * and stay silent when they are absent — these are not mandatory violations.
 */
export const HEURISTICS: Heuristic[] = [
  {
    id: "py/mutable-default-arg",
    summary: "Mutable default argument",
    hint: "Check for function definitions where a default parameter value is a mutable object such as `[]`, `{}`, or a custom class instance (e.g., `def foo(items=[])`). The default is created once at definition time and shared across all calls, causing subtle state-leakage bugs.",
  },
  {
    id: "py/bare-except",
    summary: "Bare `except:` or `except Exception:` without re-raise",
    hint: "Look for `except:` or `except Exception as e:` blocks that swallow exceptions without logging or re-raising. These hide failures and make debugging very difficult. At minimum the error should be logged.",
  },
  {
    id: "py/string-concat-logging",
    summary: "String concatenation in logging calls",
    hint: "Review logging calls that use `+` or f-strings to build the message (e.g., `logging.debug('value: ' + str(x))`). Prefer lazy `%`-style formatting (`logging.debug('value: %s', x)`) so the string is not built unless the log level is active.",
  },
  {
    id: "py/resource-leak",
    summary: "Resource not managed with `with` statement",
    hint: "Check for file opens (`open()`), database connections, or network sockets that are acquired outside a `with` block. Without a context manager the resource may not be released if an exception is raised, causing leaks.",
  },
  {
    id: "py/missing-init",
    summary: "New package directory without `__init__.py`",
    hint: "If the diff adds a new directory containing Python files, verify it includes an `__init__.py` (or is explicitly a namespace package). Missing `__init__.py` can cause import errors in non-PEP-420 environments or with certain test runners.",
  },
];
