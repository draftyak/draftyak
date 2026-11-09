import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createHashHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Setup } from "./setup.tsx";
import "./style.css";

const queryClient = new QueryClient();
const routeTree = createRootRoute({ component: Setup });
const router = createRouter({ routeTree, history: createHashHistory() });
const element = document.getElementById("root");
if (element === null) throw new Error("Application root unavailable");

createRoot(element).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
