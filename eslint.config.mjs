import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([globalIgnores(["**/next-env.d.ts", "CampusConnect/**", "backend/**"]), {
    extends: [...nextCoreWebVitals, ...nextTypescript],

    // Pin the React version so eslint-plugin-react skips its auto-detection path,
    // which crashes on ESLint 10 (context.getFilename was removed).
    settings: {
        react: {
            version: "19.2",
        },
    },

    rules: {
        "@typescript-eslint/no-explicit-any": "warn",
    },
}]);