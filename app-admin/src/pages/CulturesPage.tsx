import React, { useState, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Globe,
  Search,
  FileText,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Culture } from "@/types/culture";
import {
  useAdminCultures,
  useAdminLocalizationCounts,
  useCreateCulture,
  useUpdateCulture,
  useDeleteCulture,
} from "@/hooks/useAdminCatalog";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import LocalizationDialog from "@/components/LocalizationDialog";
import { format } from "date-fns";

const CulturesPage = () => {
  const { toast } = useToast();
  const { data: apiCultures = [] } = useAdminCultures();
  const { data: localizationCounts = {} } = useAdminLocalizationCounts();
  const [cultures, setCultures] = useState<Culture[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingCulture, setEditingCulture] = useState<Culture | null>(null);
  const [deletingCulture, setDeletingCulture] = useState<Culture | null>(null);
  const [localizationCulture, setLocalizationCulture] =
    useState<Culture | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const createCulture = useCreateCulture();
  const updateCulture = useUpdateCulture();
  const deleteCulture = useDeleteCulture();

  const [formData, setFormData] = useState({
    CultureID: "",
    Name: "",
  });

  // Populate from API
  useEffect(() => {
    if (apiCultures.length > 0) setCultures(apiCultures);
  }, [apiCultures]);

  const getLocalizationCount = (cultureId: string) => {
    return localizationCounts[cultureId.trim()] ?? 0;
  };

  const filteredCultures = cultures.filter(
    (culture) =>
      culture.Name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      culture.CultureID.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const openCreateDialog = () => {
    setEditingCulture(null);
    setFormData({ CultureID: "", Name: "" });
    setIsDialogOpen(true);
  };

  const openEditDialog = (culture: Culture) => {
    setEditingCulture(culture);
    setFormData({
      CultureID: culture.CultureID,
      Name: culture.Name,
    });
    setIsDialogOpen(true);
  };

  const openDeleteDialog = (culture: Culture) => {
    setDeletingCulture(culture);
    setIsDeleteDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.CultureID.trim() || !formData.Name.trim()) {
      toast({
        title: "Validation Error",
        description: "Culture ID and Name are required.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      if (editingCulture) {
        await updateCulture.mutateAsync({
          CultureID: editingCulture.CultureID,
          Name: formData.Name,
        });
        toast({
          title: "Culture Updated",
          description: `"${formData.Name}" has been updated.`,
        });
      } else {
        if (cultures.some((c) => c.CultureID === formData.CultureID)) {
          toast({
            title: "Duplicate ID",
            description: "A culture with this ID already exists.",
            variant: "destructive",
          });
          return;
        }
        await createCulture.mutateAsync({
          CultureID: formData.CultureID,
          Name: formData.Name,
        });
        toast({
          title: "Culture Created",
          description: `"${formData.Name}" has been added.`,
        });
      }
      setIsDialogOpen(false);
    } catch {
      toast({
        title: "Error",
        description: "Failed to save culture. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deletingCulture) {
      setIsDeleting(true);
      try {
        await deleteCulture.mutateAsync(deletingCulture.CultureID);
        toast({
          title: "Culture Deleted",
          description: `"${deletingCulture.Name}" has been removed.`,
        });
      } catch {
        toast({
          title: "Error",
          description: "Failed to delete culture. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsDeleting(false);
      }
    }
    setIsDeleteDialogOpen(false);
    setDeletingCulture(null);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex items-center gap-3">
              <Globe className="h-8 w-8 text-primary" />
              <div>
                <h1 className="text-3xl font-bold text-foreground">Cultures</h1>
                <p className="text-muted-foreground">
                  Manage language and culture settings for product localization
                </p>
              </div>
            </div>
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Add Culture
            </Button>
          </div>

          {/* Stats Card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-8">
                <div>
                  <p className="text-3xl font-bold text-primary">
                    {cultures.length}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Total Cultures
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Table */}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Culture ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Localizations</TableHead>
                    <TableHead>Last Modified</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCultures.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No cultures found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredCultures.map((culture) => (
                      <TableRow key={culture.CultureID}>
                        <TableCell className="font-mono font-medium">
                          {culture.CultureID}
                        </TableCell>
                        <TableCell>{culture.Name}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-auto py-1 px-2"
                            onClick={() => setLocalizationCulture(culture)}
                          >
                            <Badge
                              variant="secondary"
                              className="cursor-pointer hover:bg-secondary/80"
                            >
                              <FileText className="h-3 w-3 mr-1" />
                              {getLocalizationCount(culture.CultureID)} products
                            </Badge>
                          </Button>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(
                            new Date(culture.ModifiedDate),
                            "MMM d, yyyy HH:mm",
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEditDialog(culture)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openDeleteDialog(culture)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </main>

      <Footer />

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingCulture ? "Edit Culture" : "Add New Culture"}
            </DialogTitle>
            <DialogDescription>
              {editingCulture
                ? "Update the culture details below."
                : "Enter the details for the new culture."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="cultureId">Culture ID</Label>
              <Input
                id="cultureId"
                placeholder="e.g., en, fr, de"
                value={formData.CultureID}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    CultureID: e.target.value,
                  }))
                }
                disabled={!!editingCulture}
                maxLength={6}
              />
              <p className="text-xs text-muted-foreground">
                A short code identifying the culture (max 6 characters)
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., English, French, German"
                value={formData.Name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, Name: e.target.value }))
                }
                maxLength={50}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingCulture ? "Save Changes" : "Create Culture"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Culture</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingCulture?.Name}"? This
              action cannot be undone and may affect product localizations using
              this culture.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Localization Dialog */}
      {localizationCulture && (
        <LocalizationDialog
          culture={localizationCulture}
          open={!!localizationCulture}
          onOpenChange={(open) => !open && setLocalizationCulture(null)}
        />
      )}
    </div>
  );
};

export default CulturesPage;
