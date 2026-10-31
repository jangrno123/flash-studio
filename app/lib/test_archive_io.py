import io
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
import zipfile
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('archive_io',Path(__file__).with_name('archive-io.py'));archive_io=module_from_spec(spec);spec.loader.exec_module(archive_io)

class ArchiveIOTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='flash-archive-test-');self.root=Path(self.temp.name).resolve()
    def tearDown(self):self.temp.cleanup()
    def archive(self,entries):
        file=self.root/'source.zip'
        with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED) as z:
            for name,data in entries:z.writestr(name,data)
        return file
    def extract(self,file):return archive_io.archive_task({'action':'extract','source':str(file),'destination':str(self.root/'output'),'allowed_roots':[str(self.root)]})
    def test_unicode_listing_extraction_and_idempotent_reuse(self):
        file=self.archive([('폴더/한글.txt','내용'.encode()),('image.png',b'pixels')]);before=file.read_bytes()
        listed=archive_io.archive_task({'action':'list','source':str(file),'offset':1,'max_results':1});self.assertEqual(listed['totalEntries'],2)
        first=self.extract(file);self.assertEqual(first['extracted'],2);self.assertEqual((self.root/'output/폴더/한글.txt').read_text(encoding='utf-8'),'내용')
        again=self.extract(file);self.assertEqual(again['skippedExistingIdentical'],2);self.assertEqual(file.read_bytes(),before)
    def test_unsafe_paths_are_rejected_before_writing(self):
        for name in ['../escape.txt','C:/bad.txt','file.txt:stream','/absolute.txt','CON.txt','dir/bad.']:
            file=self.archive([('good.txt',b'ok'),(name,b'bad')])
            with self.assertRaises(ValueError):self.extract(file)
            self.assertFalse((self.root/'output/good.txt').exists())
    def test_existing_different_files_are_never_overwritten(self):
        file=self.archive([('keep.txt',b'new')]);(self.root/'output').mkdir();(self.root/'output/keep.txt').write_bytes(b'old')
        with self.assertRaises(ValueError):self.extract(file)
        self.assertEqual((self.root/'output/keep.txt').read_bytes(),b'old')
    def test_case_collisions_and_symlinks_are_rejected(self):
        with self.assertRaises(ValueError):self.extract(self.archive([('a.txt',b'a'),('A.txt',b'b')]))
        link=zipfile.ZipInfo('link');link.create_system=3;link.external_attr=(0o120777<<16)
        with self.assertRaises(ValueError):self.extract(self.archive([(link,b'outside')]))
    def test_tar_gzip_extracts_without_archive_modules(self):
        file=self.root/'source.tar.gz'
        with tarfile.open(file,'w:gz') as z:
            item=tarfile.TarInfo('dir/a.txt');item.size=4;z.addfile(item,io.BytesIO(b'data'))
        result=self.extract(file);self.assertEqual(result['fileCount'],1);self.assertEqual((self.root/'output/dir/a.txt').read_bytes(),b'data')
    def test_zip_creation_preserves_source_and_refuses_overwrite(self):
        src=self.root/'source.txt';src.write_bytes(b'original');dest=self.root/'new.zip';request={'action':'create','sources':[str(src)],'destination':str(dest)}
        result=archive_io.create_archive(request);self.assertEqual(result['fileCount'],1);self.assertEqual(src.read_bytes(),b'original')
        with zipfile.ZipFile(dest) as z:self.assertEqual(z.read('source.txt'),b'original')
        with self.assertRaises(ValueError):archive_io.create_archive(request)
if __name__=='__main__':unittest.main()
