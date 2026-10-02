import { json, error, positiveInt, segment } from "../http.js";

const STOCK_ROUTE = /^\/api\/products\/[^/]+\/stock$/;

export const catalogRoutes = [
  {
    method: "GET",
    match: (path) => path === "/api/products",
    async handler({ store, url, scenario }) {
      const component = "catalog";
      if (scenario === "database_timeout") {
        return {
          response: error("DATABASE_TIMEOUT", "The catalogue service could not reach its database", 503),
          event: "database_timeout",
          component,
          severity: "ERROR",
          message: "Simulated database timeout while listing products"
        };
      }

      const products = await store.listProducts({
        q: url.searchParams.get("q") || null,
        category: url.searchParams.get("category") || null
      });
      return {
        response: json({ products }),
        event: "product_catalog_listed",
        component,
        message: `Catalogue returned ${products.length} products`
      };
    }
  },

  {
    method: "GET",
    match: (path) => path === "/api/products/all",
    async handler({ store, isStaff }) {
      const component = "operations";
      if (!isStaff) {
        return {
          response: error("FORBIDDEN", "Staff credentials are required to view the full catalogue", 403),
          event: "auth_unauthorized_access",
          component,
          severity: "WARNING",
          message: "Unauthorized full catalogue query"
        };
      }
      return {
        response: json({ products: await store.listProducts({ includeInactive: true }) }),
        event: "product_inventory_listed",
        component,
        message: "Full product inventory retrieved"
      };
    }
  },

  {
    method: "GET",
    match: (path) => path === "/api/categories",
    async handler({ store }) {
      return {
        response: json({ categories: await store.listCategories() }),
        event: "product_categories_listed",
        component: "catalog",
        message: "Categories retrieved"
      };
    }
  },

  {
    method: "PATCH",
    match: (path) => STOCK_ROUTE.test(path),
    async handler({ store, isStaff, path, requestBody }) {
      const component = "operations";
      if (!isStaff) {
        return {
          response: error("FORBIDDEN", "Staff credentials are required to adjust stock", 403),
          event: "auth_unauthorized_access",
          component,
          severity: "WARNING",
          message: "Unauthorized stock adjustment attempt"
        };
      }

      const { stockQuantity, status } = requestBody ?? {};
      const stockValid = stockQuantity === undefined || positiveInt(stockQuantity);
      const statusValid = status === undefined || status === "ACTIVE" || status === "OUT_OF_STOCK";

      if (!stockValid || !statusValid || (stockQuantity === undefined && status === undefined)) {
        return {
          response: error(
            "VALIDATION_ERROR",
            "Provide stockQuantity as a non-negative integer and/or status as ACTIVE or OUT_OF_STOCK",
            422
          ),
          event: "product_stock_invalid",
          component,
          severity: "WARNING",
          message: "Invalid stock adjustment"
        };
      }

      const result = await store.updateProductStock(segment(path, 3), { stockQuantity, status });
      if (result.kind === "not_found") {
        return {
          response: error("PRODUCT_NOT_FOUND", "The product does not exist", 404),
          event: "product_stock_missing",
          component,
          severity: "WARNING",
          message: "Stock adjustment referenced a missing product"
        };
      }

      return {
        response: json({ product: result.product }),
        event: "product_stock_updated",
        component,
        message: "Product stock updated"
      };
    }
  }
];
