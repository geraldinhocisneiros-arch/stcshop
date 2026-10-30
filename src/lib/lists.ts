import { loadBrands, loadCategories } from "./data";
import type { Category, Product } from "./types";

/** Listas cadastráveis do produto (categoria e marca): mesma tela, tabelas diferentes. */
export type ListKind = "category" | "brand";

export const LISTS: Record<
  ListKind,
  {
    table: "shop_categories" | "shop_brands";
    rename: "shop_rename_category" | "shop_rename_brand";
    remove: "shop_delete_category" | "shop_delete_brand";
    field: "category" | "brand";
    singular: string;
    plural: string;
    article: "a" | "o";
    placeholder: string;
    hasCode: boolean;
    load: () => Promise<Category[]>;
  }
> = {
  category: {
    table: "shop_categories",
    rename: "shop_rename_category",
    remove: "shop_delete_category",
    field: "category",
    singular: "categoria",
    plural: "Categorias",
    article: "a",
    placeholder: "Nova categoria (ex.: Bolas, Cordas, Raquetes)",
    hasCode: false,
    load: loadCategories,
  },
  brand: {
    table: "shop_brands",
    rename: "shop_rename_brand",
    remove: "shop_delete_brand",
    field: "brand",
    singular: "marca",
    plural: "Marcas",
    article: "a",
    placeholder: "Nova marca (ex.: Wilson, Babolat, Head)",
    hasCode: true,
    load: loadBrands,
  },
};

export const productListValue = (p: Product, kind: ListKind) => (kind === "brand" ? p.brand : p.category);
