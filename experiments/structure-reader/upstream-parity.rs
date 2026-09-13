// Independent native reference: call the upstream public APIs directly.
use legal_pdf_core::{OcrLine, OcrPageRequest, OcrPageResult, PdfOcrProvider};
use legal_pdf_structure::{derive, StructureIdentity};
use legal_pdf_support::ppdoc_postprocess::{annotate_regions, scale_detections, PPDocDetection};

#[derive(serde::Deserialize)]
struct Layout { width:u32, height:u32, detections:Vec<PPDocDetection> }

struct FixtureOcr(Vec<Vec<OcrLine>>);
impl PdfOcrProvider for FixtureOcr {
    fn extract_pages(&mut self, _: &[u8], requests: &[OcrPageRequest]) -> legal_pdf_core::Result<Vec<OcrPageResult>> {
        Ok(requests.iter().map(|request|OcrPageResult {
            page_index:request.page_index,lines:self.0[request.page_index].clone(),separator_y:None,
        }).collect())
    }
}
fn main() {
    let args=std::env::args().collect::<Vec<_>>();
    let bytes=std::fs::read(&args[1]).unwrap();
    let mut ocr=args.get(2).map(|path|FixtureOcr(serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()));
    let mut extracted=legal_pdf_extraction::extract_pdf(&bytes,ocr.as_mut().map(|provider|provider as &mut dyn PdfOcrProvider),None).unwrap();
    let raw=serde_json::to_value(&extracted).unwrap();
    if let Some(path)=args.get(3) {
        let layouts:Vec<Option<Layout>>=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let count=layouts.iter().flatten().map(|layout|layout.detections.len()).sum();
        let regions=layouts.iter().zip(&extracted.pages).map(|(layout,page)|layout.as_ref().map(|layout|
            scale_detections(page.width,page.height,layout.width,layout.height,&layout.detections)
        ).unwrap_or_default()).collect();
        extracted.diagnostics.extend(annotate_regions(&mut extracted.pages,regions,count).unwrap());
    }
    let output=derive(&mut extracted.pages,&extracted.separators,StructureIdentity {
        document_id:"browser-pdf".into(),source_sha256:String::new(),
    }).unwrap();
    extracted.diagnostics.extend(output.diagnostics);
    println!("{}",serde_json::json!({"extracted":raw,"detected":{
        "nodes":output.structure_graph.nodes,"offset_unit":output.structure_graph.offset_unit,
        "pages":extracted.pages,"diagnostics":extracted.diagnostics,
    }}));
}
