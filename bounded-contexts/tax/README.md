# Tax

Tax owns provider-agnostic sales tax quote contracts and local quote behavior.

Ordering requests tax through an injected quote resolver when creating orders, then stores the resulting tax snapshot with the order. The context is intentionally provider-light for now so production tax providers can be added without coupling Ordering to vendor APIs.
