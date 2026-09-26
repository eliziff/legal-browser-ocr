// Independent native reference: call the upstream public APIs directly.
use legal_pdf_core::{OcrLine, OcrPageRequest, OcrPageResult, PdfOcrProvider};
use legal_pdf_structure::{derive, StructureIdentity};
use legal_pdf_support::ppdoc_postprocess::{annotate_regions, scale_detections, PPDocDetection};

#[derive(serde::Deserialize)]
struct Layout { width:u32, height:u32, detections:Vec<PPDocDetection>, #[serde(default)] separator_y:Option<f64> }

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
    if args[1] == "--text-profile" {
        let text=std::fs::read_to_string(&args[3]).unwrap();
        let document=match args[2].as_str() {
            "1"=>legal_structure::provider_text_document_structure(legal_structure::ProviderTextInput::new("",legal_structure::ProviderTextSourceKind::Laws,&text)).unwrap(),
            "2"=>legal_structure::analyze_instrument(&text,"browser-pdf".into(),&[],false).unwrap(),
            _=>panic!("Unknown profile"),
        };
        println!("{}",serde_json::to_string(&document).unwrap());return;
    }
    if args[1] == "--raster" {
        let width:u32=args[3].parse().unwrap();let height:u32=args[4].parse().unwrap();
        let rgb=std::fs::read(&args[2]).unwrap();
        let gray=rgb.chunks_exact(3).map(|p|((u32::from(p[0])*77+u32::from(p[1])*150+u32::from(p[2])*29)/256) as u8).collect::<Vec<_>>();
        let image=image::RgbImage::from_raw(width,height,rgb).unwrap();
        let (size,mean,std)=if args[5]=="1" {(480,[0.485,0.456,0.406],[0.229,0.224,0.225])}else{(800,[0.0;3],[1.0;3])};
        let pixels=legal_pdf_support::ppdoc_inference::resize_opencv_cubic_nchw(&image,size,size,1.0/255.0,mean,std);
        println!("{}",serde_json::json!({"samples":(0..257).map(|i|pixels[i*(pixels.len()-1)/256]).collect::<Vec<_>>(),
            "separator":legal_pdf_ocr::raster_separator_y_from_gray(&gray,width as usize,height as usize,1.0)}));
        return;
    }

    let bytes=std::fs::read(&args[1]).unwrap();
    let mut ocr=args.get(2).map(|path|FixtureOcr(serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()));
    let mut extracted=legal_pdf_extraction::extract_pdf(&bytes,ocr.as_mut().map(|provider|provider as &mut dyn PdfOcrProvider),None).unwrap();
    let raw=serde_json::to_value(&extracted).unwrap();
    if let Some(path)=args.get(3) {
        let layouts:Vec<Option<Layout>>=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for (index, (page, layout)) in extracted.pages.iter().zip(&layouts).enumerate() {
            if page.source == "ocr" {
                if let Some(y) = layout.as_ref().and_then(|layout| layout.separator_y) {
                    extracted.separators[index] = Some(y * page.height);
                }
            }
        }
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
