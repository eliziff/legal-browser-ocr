use legal_structure::{
    analyze_instrument, provider_text_document_structure, ProviderTextInput, ProviderTextSourceKind,
};
use serde_json::json;

// The worker owns each allocation and frees it once. This small ABI avoids a
// second binding runtime; no document content crosses a network boundary.
#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}

#[no_mangle]
pub unsafe extern "C" fn detect(ptr: *const u8, len: usize, profile: u32) -> u64 {
    let response = if len > 4_000_000 {
        json!({"error": "This experiment supports up to 4 MB of OCR text."})
    } else if let Ok(text) = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)) {
        let result = match profile {
            0 | 1 => provider_text_document_structure(ProviderTextInput::new(
                "",
                if profile == 0 {
                    ProviderTextSourceKind::Cases
                } else {
                    ProviderTextSourceKind::Laws
                },
                text,
            )),
            2 => analyze_instrument(text, "browser-ocr".into(), &[], false),
            _ => return pack(json!({"error": "Unknown document profile."})),
        };
        match result {
            Ok(document) => json!({"nodes": document.nodes, "offset_unit": document.offset_unit}),
            Err(error) => json!({"error": error.to_string()}),
        }
    } else {
        json!({"error": "Invalid UTF-8 text."})
    };
    pack(response)
}

fn pack(value: serde_json::Value) -> u64 {
    let bytes = serde_json::to_vec(&value).unwrap().into_boxed_slice();
    let len = bytes.len() as u64;
    let ptr = Box::into_raw(bytes) as *mut u8 as u64;
    (len << 32) | ptr
}
