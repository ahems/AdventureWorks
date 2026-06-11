import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Trash2 } from 'lucide-react';

interface Props {
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  isPending?: boolean;
  triggerClassName?: string;
}

const DeleteConfirmDialog = ({ title, description, onConfirm, isPending, triggerClassName }: Props) => {
  const [open, setOpen] = useState(false);

  const handleConfirm = async () => {
    await onConfirm();
    setOpen(false);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className={triggerClassName || "text-doodle-accent hover:text-doodle-accent/80 transition-colors"} title="Delete">
        <Trash2 className="w-4 h-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-accent">{title}</DialogTitle>
          </DialogHeader>
          <p className="font-doodle text-sm text-doodle-text">{description}</p>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="doodle-button text-sm">Cancel</button>
            <button onClick={handleConfirm} disabled={isPending} className="doodle-button doodle-button-accent text-sm disabled:opacity-50">
              {isPending ? 'Deleting...' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default DeleteConfirmDialog;
