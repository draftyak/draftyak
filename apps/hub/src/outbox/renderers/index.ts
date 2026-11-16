export {
	type NativeBuiltinSendInput,
	type NativeGmailWireInput,
	renderNativeBuiltinSend,
} from "./catalog.ts";
export {
	assertNativeSendRenderMatches,
	captureNativeSendRender,
	MAX_NATIVE_SEND_BODY_BYTES,
	type NativeRenderedSend,
	NativeSendRenderError,
	nativeSendRenderProjection,
} from "./native.ts";
